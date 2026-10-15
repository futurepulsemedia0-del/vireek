/*
  # Documents vault (/dashboard/documents)

  Licenses, insurance, contracts, permits and other business paperwork with:
  - expiry tracking + in-app alerts (notifications table, deduped per stage)
  - append-only versioning (every upload is a new immutable version)
  - private storage bucket, access only through short-lived signed URLs
  - optional per-customer attachment (documents.customer_id)

  Tenancy: every row is scoped by user_id = get_account_owner_id(), so an
  owner AND their team members see the same vault (same pattern as
  notifications / commitment_graph). Reads are open to the whole account;
  writes (insert/update/delete + storage writes) require can_manage_documents():
  the account owner, or a team member whose effective
  `can_edit_business_profile` permission is true (custom role overrides the
  base team_members flags, exactly like AuthContext does on the client).

  Purely additive: no existing table is altered.
*/

-- =============================================================
-- PERMISSION HELPER
-- =============================================================
CREATE OR REPLACE FUNCTION public.can_manage_documents()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    -- account owner (has a profile and is not someone's team member)
    (
      EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
      AND NOT EXISTS (SELECT 1 FROM team_members t WHERE t.user_id = auth.uid())
    )
    OR
    -- team member with the effective permission (custom role wins where it defines a value)
    EXISTS (
      SELECT 1
      FROM team_members t
      LEFT JOIN custom_roles cr ON cr.id = t.custom_role_id
      WHERE t.user_id = auth.uid()
        AND COALESCE(
              (cr.permissions ->> 'can_edit_business_profile')::boolean,
              (t.permissions ->> 'can_edit_business_profile')::boolean,
              false
            )
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_documents() TO authenticated;

-- =============================================================
-- DOCUMENTS
-- =============================================================
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  category text NOT NULL DEFAULT 'other'
    CHECK (category IN ('license', 'insurance', 'contract', 'permit', 'other')),
  reference_number text CHECK (reference_number IS NULL OR char_length(reference_number) <= 120),
  issuer text CHECK (issuer IS NULL OR char_length(issuer) <= 200),
  issued_on date,
  expires_on date,
  -- start alerting this many days before expires_on
  alert_days integer NOT NULL DEFAULT 30 CHECK (alert_days BETWEEN 0 AND 365),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 4000),
  -- denormalised from document_versions by trigger (keeps the list query join-free)
  current_version_id uuid,
  version_count integer NOT NULL DEFAULT 0,
  current_file_name text,
  current_file_size bigint,
  current_mime_type text,
  -- last expiry alert stage sent: 'expiring' | 'expired' (NULL = none yet)
  last_alert_stage text CHECK (last_alert_stage IS NULL OR last_alert_stage IN ('expiring', 'expired')),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (issued_on IS NULL OR expires_on IS NULL OR expires_on >= issued_on)
);

CREATE INDEX IF NOT EXISTS idx_documents_user_expires ON documents(user_id, expires_on);
CREATE INDEX IF NOT EXISTS idx_documents_user_category ON documents(user_id, category);
CREATE INDEX IF NOT EXISTS idx_documents_customer ON documents(customer_id) WHERE customer_id IS NOT NULL;

-- A document may only be attached to a customer of the SAME account.
CREATE OR REPLACE FUNCTION public.documents_validate_customer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM customers c WHERE c.id = NEW.customer_id AND c.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'customer does not belong to this account' USING ERRCODE = '42501';
  END IF;

  -- Changing the expiry date re-arms alerts for the new date.
  IF TG_OP = 'UPDATE' AND NEW.expires_on IS DISTINCT FROM OLD.expires_on THEN
    NEW.last_alert_stage := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_documents_validate ON documents;
CREATE TRIGGER trg_documents_validate
  BEFORE INSERT OR UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION public.documents_validate_customer();

DROP TRIGGER IF EXISTS trg_documents_updated_at ON documents;
CREATE TRIGGER trg_documents_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_documents" ON documents;
CREATE POLICY "select_account_documents" ON documents FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_account_documents" ON documents;
CREATE POLICY "insert_account_documents" ON documents FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_documents());

DROP POLICY IF EXISTS "update_account_documents" ON documents;
CREATE POLICY "update_account_documents" ON documents FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_documents())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_documents());

DROP POLICY IF EXISTS "delete_account_documents" ON documents;
CREATE POLICY "delete_account_documents" ON documents FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_documents());

-- =============================================================
-- DOCUMENT VERSIONS (append-only)
-- =============================================================
CREATE TABLE IF NOT EXISTS document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  version_number integer NOT NULL,
  storage_path text NOT NULL CHECK (char_length(storage_path) <= 500),
  file_name text NOT NULL CHECK (char_length(file_name) <= 255),
  mime_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 26214400),
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  uploaded_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_number),
  UNIQUE (storage_path)
);

CREATE INDEX IF NOT EXISTS idx_document_versions_doc ON document_versions(document_id, version_number DESC);

-- Assigns version_number race-free (row lock on the parent), forces user_id to
-- the parent's account, and requires the storage path to live under that account.
CREATE OR REPLACE FUNCTION public.document_versions_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  SELECT d.user_id INTO v_owner FROM documents d WHERE d.id = NEW.document_id FOR UPDATE;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'document not found' USING ERRCODE = '42501';
  END IF;

  NEW.user_id := v_owner;
  NEW.version_number := COALESCE(
    (SELECT max(v.version_number) FROM document_versions v WHERE v.document_id = NEW.document_id), 0
  ) + 1;

  IF split_part(NEW.storage_path, '/', 1) <> v_owner::text THEN
    RAISE EXCEPTION 'storage path outside account folder' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_versions_before_insert ON document_versions;
CREATE TRIGGER trg_document_versions_before_insert
  BEFORE INSERT ON document_versions
  FOR EACH ROW EXECUTE FUNCTION public.document_versions_before_insert();

-- Keeps the denormalised "current version" columns on documents in sync.
CREATE OR REPLACE FUNCTION public.document_versions_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE documents
  SET current_version_id = NEW.id,
      version_count = NEW.version_number,
      current_file_name = NEW.file_name,
      current_file_size = NEW.size_bytes,
      current_mime_type = NEW.mime_type
  WHERE id = NEW.document_id;

  PERFORM public.log_audit_event(NEW.user_id, 'document_version_uploaded', 'documents', NEW.document_id::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_versions_after_insert ON document_versions;
CREATE TRIGGER trg_document_versions_after_insert
  AFTER INSERT ON document_versions
  FOR EACH ROW EXECUTE FUNCTION public.document_versions_after_insert();

ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_document_versions" ON document_versions;
CREATE POLICY "select_account_document_versions" ON document_versions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- No UPDATE / DELETE policies on purpose: versions are immutable. They are only
-- removed by the ON DELETE CASCADE when the whole document is deleted.
DROP POLICY IF EXISTS "insert_account_document_versions" ON document_versions;
CREATE POLICY "insert_account_document_versions" ON document_versions FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_documents());

-- Audit trail for deletions (owner-only audit_log, written by SECURITY DEFINER fn).
CREATE OR REPLACE FUNCTION public.documents_after_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.log_audit_event(OLD.user_id, 'document_deleted', 'documents', OLD.id::text);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_documents_after_delete ON documents;
CREATE TRIGGER trg_documents_after_delete
  AFTER DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION public.documents_after_delete();

-- =============================================================
-- STORAGE: private bucket, folder = account owner id
-- Path layout: <account_owner_id>/<document_id>/<version_id>-<safe_name>
-- =============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'documents',
  'documents',
  false,
  26214400, -- 25 MB
  ARRAY[
    'application/pdf',
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain', 'text/csv'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "documents_read_account" ON storage.objects;
CREATE POLICY "documents_read_account" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'documents' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);

DROP POLICY IF EXISTS "documents_insert_manager" ON storage.objects;
CREATE POLICY "documents_insert_manager" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.can_manage_documents()
  );

DROP POLICY IF EXISTS "documents_update_manager" ON storage.objects;
CREATE POLICY "documents_update_manager" ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.can_manage_documents()
  );

DROP POLICY IF EXISTS "documents_delete_manager" ON storage.objects;
CREATE POLICY "documents_delete_manager" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.can_manage_documents()
  );

-- =============================================================
-- EXPIRY ALERTS
-- =============================================================
-- Core routine: writes at most ONE notification per document per stage
-- ('expiring' once the alert window opens, 'expired' once past due).
-- Changing expires_on resets last_alert_stage (see trigger above), so a
-- renewed document alerts again for its new date.
CREATE OR REPLACE FUNCTION public.generate_document_expiry_notifications(p_account uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_stage text;
  v_days integer;
  v_count integer := 0;
BEGIN
  FOR r IN
    SELECT id, user_id, title, expires_on, alert_days, last_alert_stage
    FROM documents
    WHERE expires_on IS NOT NULL
      AND (p_account IS NULL OR user_id = p_account)
      AND expires_on <= (current_date + alert_days)
    FOR UPDATE SKIP LOCKED
  LOOP
    v_days := r.expires_on - current_date;
    v_stage := CASE WHEN v_days < 0 THEN 'expired' ELSE 'expiring' END;

    IF r.last_alert_stage IS NOT DISTINCT FROM v_stage
       OR (r.last_alert_stage = 'expired' AND v_stage = 'expiring') THEN
      CONTINUE;
    END IF;

    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (
      r.user_id,
      'system',
      CASE WHEN v_stage = 'expired' THEN 'Document expired' ELSE 'Document expiring soon' END,
      CASE
        WHEN v_stage = 'expired' THEN r.title || ' expired ' || abs(v_days) || ' day(s) ago.'
        WHEN v_days = 0 THEN r.title || ' expires today.'
        ELSE r.title || ' expires in ' || v_days || ' day(s).'
      END,
      '/dashboard/documents?doc=' || r.id
    );

    UPDATE documents SET last_alert_stage = v_stage WHERE id = r.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- Never callable by clients directly (it accepts an arbitrary account id).
REVOKE ALL ON FUNCTION public.generate_document_expiry_notifications(uuid) FROM PUBLIC, anon, authenticated;

-- Client-callable wrapper: only ever runs for the caller's OWN account, so the
-- vault page can trigger alerts on open without needing pg_cron.
CREATE OR REPLACE FUNCTION public.check_my_document_expiries()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid := public.get_account_owner_id();
BEGIN
  IF v_account IS NULL THEN
    RETURN 0;
  END IF;
  RETURN public.generate_document_expiry_notifications(v_account);
END;
$$;

REVOKE ALL ON FUNCTION public.check_my_document_expiries() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_my_document_expiries() TO authenticated;

/*
  OPTIONAL (recommended once pg_cron is enabled on the project): alerts that
  fire even when nobody opens the dashboard. Run once, manually:

    SELECT cron.schedule(
      'document-expiry-alerts',
      '0 7 * * *',
      $$ SELECT public.generate_document_expiry_notifications(NULL) $$
    );
*/
