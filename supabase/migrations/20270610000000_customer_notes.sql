/*
  # Customer notes (internal notes + attachments on the customer timeline)

  Powers the unified activity timeline on CustomerDetailPage
  (src/components/customers/CustomerTimeline.tsx): internal team notes, pinned
  notes and file attachments. Calls / SMS / email / jobs / quotes / invoices /
  payments / reviews are NOT copied here — they are read from their own tables
  and merged client-side (src/lib/customerTimeline.ts), so there is no
  second source of truth to keep in sync.

  ## Access model (enforced here, not just in the UI)
  - Everything is scoped to the account: user_id = public.get_account_owner_id().
  - Any account member who can see the customer can read notes and add notes.
  - Only the note's author, or a manager (account owner / team member whose
    effective can_view_all_jobs is true — public.tasks_can_view_all(), defined
    in 20270501000000_tasks.sql), can edit, pin/unpin or delete a note.
  - Attachments follow the same rule as their note. Files live in the PRIVATE
    storage bucket `customer-note-files`; the first path segment must be the
    account owner id, and the app only ever hands out short-lived signed URLs.
  - At most 5 pinned notes per customer (trigger).

  Requires: get_account_owner_id(), tasks_can_view_all(), profiles, customers.
  Note: deleting a customer cascades its notes/attachment rows but cannot
  delete the stored files (Supabase storage objects are removed through the
  storage API). The app removes files when a note or attachment is deleted.
*/

-- ---------------------------------------------------------------------------
-- customer_notes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  author_id uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  author_name text CHECK (author_name IS NULL OR char_length(author_name) <= 120),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 8000),
  pinned boolean NOT NULL DEFAULT false,
  pinned_at timestamptz,
  pinned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  edited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_notes_customer_created
  ON public.customer_notes (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_notes_customer_pinned
  ON public.customer_notes (customer_id) WHERE pinned;
CREATE INDEX IF NOT EXISTS idx_customer_notes_user
  ON public.customer_notes (user_id);

-- ---------------------------------------------------------------------------
-- Integrity trigger: trims body, locks ownership columns, owns pin/edit stamps,
-- caps pinned notes per customer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_notes_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_was_pinned boolean := false;
  v_old_pinned_at timestamptz;
  v_old_pinned_by uuid;
BEGIN
  NEW.body := btrim(NEW.body);

  IF TG_OP = 'UPDATE' THEN
    v_was_pinned := OLD.pinned;
    v_old_pinned_at := OLD.pinned_at;
    v_old_pinned_by := OLD.pinned_by;
    NEW.user_id := OLD.user_id;
    NEW.customer_id := OLD.customer_id;
    NEW.author_id := OLD.author_id;
    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
    IF NEW.body IS DISTINCT FROM OLD.body THEN
      NEW.edited_at := now();
    ELSE
      NEW.edited_at := OLD.edited_at;
    END IF;
  END IF;

  IF NEW.pinned THEN
    IF v_was_pinned THEN
      NEW.pinned_at := v_old_pinned_at;
      NEW.pinned_by := v_old_pinned_by;
    ELSE
      NEW.pinned_at := now();
      NEW.pinned_by := auth.uid();
      IF (SELECT count(*) FROM public.customer_notes n
          WHERE n.customer_id = NEW.customer_id AND n.pinned AND n.id <> NEW.id) >= 5 THEN
        RAISE EXCEPTION 'too_many_pinned_notes' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    NEW.pinned_at := NULL;
    NEW.pinned_by := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_customer_notes_before_write ON public.customer_notes;
CREATE TRIGGER trigger_customer_notes_before_write
  BEFORE INSERT OR UPDATE ON public.customer_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.customer_notes_before_write();

-- ---------------------------------------------------------------------------
-- customer_notes RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.customer_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customer_notes_select" ON public.customer_notes;
CREATE POLICY "customer_notes_select" ON public.customer_notes
  FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.customers c WHERE c.id = customer_id)
  );

DROP POLICY IF EXISTS "customer_notes_insert" ON public.customer_notes;
CREATE POLICY "customer_notes_insert" ON public.customer_notes
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND author_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.customers c WHERE c.id = customer_id)
  );

DROP POLICY IF EXISTS "customer_notes_update" ON public.customer_notes;
CREATE POLICY "customer_notes_update" ON public.customer_notes
  FOR UPDATE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (author_id = auth.uid() OR public.tasks_can_view_all())
  )
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND (author_id = auth.uid() OR public.tasks_can_view_all())
  );

DROP POLICY IF EXISTS "customer_notes_delete" ON public.customer_notes;
CREATE POLICY "customer_notes_delete" ON public.customer_notes
  FOR DELETE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (author_id = auth.uid() OR public.tasks_can_view_all())
  );

-- ---------------------------------------------------------------------------
-- customer_note_attachments (metadata; bytes live in storage)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_note_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES public.customer_notes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  storage_path text NOT NULL UNIQUE CHECK (char_length(storage_path) BETWEEN 1 AND 500),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  mime_type text NOT NULL CHECK (char_length(mime_type) BETWEEN 1 AND 150),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  uploaded_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The path must live under <owner>/<customer>/<note>/ so a row can never
  -- point at another account's (or another customer's) file.
  CONSTRAINT customer_note_attachments_path_scope
    CHECK (starts_with(storage_path, user_id::text || '/' || customer_id::text || '/' || note_id::text || '/'))
);

CREATE INDEX IF NOT EXISTS idx_customer_note_attachments_note
  ON public.customer_note_attachments (note_id);
CREATE INDEX IF NOT EXISTS idx_customer_note_attachments_customer
  ON public.customer_note_attachments (customer_id);

ALTER TABLE public.customer_note_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customer_note_attachments_select" ON public.customer_note_attachments;
CREATE POLICY "customer_note_attachments_select" ON public.customer_note_attachments
  FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.customer_notes n WHERE n.id = note_id)
  );

DROP POLICY IF EXISTS "customer_note_attachments_insert" ON public.customer_note_attachments;
CREATE POLICY "customer_note_attachments_insert" ON public.customer_note_attachments
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND uploaded_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.customer_notes n
      WHERE n.id = note_id
        AND n.customer_id = customer_note_attachments.customer_id
        AND n.user_id = customer_note_attachments.user_id
        AND (n.author_id = auth.uid() OR public.tasks_can_view_all())
    )
  );

DROP POLICY IF EXISTS "customer_note_attachments_delete" ON public.customer_note_attachments;
CREATE POLICY "customer_note_attachments_delete" ON public.customer_note_attachments
  FOR DELETE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (uploaded_by = auth.uid() OR public.tasks_can_view_all())
  );

-- ---------------------------------------------------------------------------
-- Private storage bucket for the files
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'customer-note-files',
  'customer-note-files',
  false,
  10485760,
  ARRAY[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic',
    'application/pdf', 'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "customer_note_files_select" ON storage.objects;
CREATE POLICY "customer_note_files_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'customer-note-files'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
  );

DROP POLICY IF EXISTS "customer_note_files_insert" ON storage.objects;
CREATE POLICY "customer_note_files_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'customer-note-files'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
  );

DROP POLICY IF EXISTS "customer_note_files_delete" ON storage.objects;
CREATE POLICY "customer_note_files_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'customer-note-files'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND (owner_id = auth.uid()::text OR public.tasks_can_view_all())
  );
