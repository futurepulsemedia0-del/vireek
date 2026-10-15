/*
  # Job photo gallery (/dashboard/gallery)

  One searchable library for every job photo: tags, captions, pin annotations,
  before/after pairing, bulk ZIP download. Private bucket, signed URLs only.

  Tenancy: rows are keyed by user_id = get_account_owner_id() so an owner and
  their whole team share one gallery (same pattern as notifications / documents).

  Permissions (also enforced in the UI):
    - read   : every account member
    - upload : every account member (field technicians shoot the photos)
    - edit   : account owner / can_edit_business_profile, OR the uploader (own photos)
    - delete : account owner / can_edit_business_profile only

  Legacy photos in jobs.before_photos / after_photos (public job-room-photos
  bucket) are NOT migrated or modified; the UI shows them read-only next to
  the new ones. Purely additive migration.
*/

-- =============================================================
-- PERMISSION HELPER (same effective-permission logic as AuthContext)
-- =============================================================
CREATE OR REPLACE FUNCTION public.can_manage_job_photos()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (
      EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
      AND NOT EXISTS (SELECT 1 FROM team_members t WHERE t.user_id = auth.uid())
    )
    OR EXISTS (
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

GRANT EXECUTE ON FUNCTION public.can_manage_job_photos() TO authenticated;

-- =============================================================
-- JOB PHOTOS
-- =============================================================
CREATE TABLE IF NOT EXISTS job_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  storage_path text NOT NULL UNIQUE CHECK (char_length(storage_path) <= 500),
  thumb_path text CHECK (thumb_path IS NULL OR char_length(thumb_path) <= 500),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  mime_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 15728640),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  kind text NOT NULL DEFAULT 'progress' CHECK (kind IN ('before', 'after', 'progress', 'other')),
  -- two photos (one before + one after) sharing a pair_id form a before/after pair
  pair_id uuid,
  caption text CHECK (caption IS NULL OR char_length(caption) <= 1000),
  tags text[] NOT NULL DEFAULT '{}',
  -- [{ x:0..1, y:0..1, type:'circle'|'arrow'|'label', label?:text }]
  annotations jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(annotations) = 'array' AND jsonb_array_length(annotations) <= 50),
  taken_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_photos_user_taken ON job_photos(user_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_photos_job ON job_photos(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_photos_customer ON job_photos(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_photos_pair ON job_photos(pair_id) WHERE pair_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_photos_tags ON job_photos USING gin(tags);

-- Integrity + normalisation, runs before RLS WITH CHECK is evaluated.
CREATE OR REPLACE FUNCTION public.job_photos_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_customer uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
       OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by THEN
      RAISE EXCEPTION 'immutable photo fields cannot be changed' USING ERRCODE = '42501';
    END IF;
    -- changing the kind dissolves the pairing (a pair is exactly one before + one after)
    IF NEW.kind IS DISTINCT FROM OLD.kind AND NEW.pair_id IS NOT DISTINCT FROM OLD.pair_id THEN
      NEW.pair_id := NULL;
    END IF;
  END IF;

  -- The storage object must live inside this account's folder.
  IF split_part(NEW.storage_path, '/', 1) <> NEW.user_id::text
     OR (NEW.thumb_path IS NOT NULL AND split_part(NEW.thumb_path, '/', 1) <> NEW.user_id::text) THEN
    RAISE EXCEPTION 'storage path outside account folder' USING ERRCODE = '42501';
  END IF;

  IF NEW.job_id IS NOT NULL THEN
    SELECT j.customer_id INTO v_job_customer
    FROM jobs j WHERE j.id = NEW.job_id AND j.user_id = NEW.user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'job does not belong to this account' USING ERRCODE = '42501';
    END IF;
    IF NEW.customer_id IS NULL THEN
      NEW.customer_id := v_job_customer;
    END IF;
  END IF;

  IF NEW.customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM customers c WHERE c.id = NEW.customer_id AND c.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'customer does not belong to this account' USING ERRCODE = '42501';
  END IF;

  -- Tags: lower-case, trimmed, <= 40 chars, de-duplicated, max 20.
  NEW.tags := COALESCE(
    (SELECT array_agg(t ORDER BY t)
       FROM (SELECT DISTINCT left(lower(btrim(x)), 40) AS t
               FROM unnest(NEW.tags) AS x
              WHERE btrim(x) <> '') s),
    '{}'
  );
  IF cardinality(NEW.tags) > 20 THEN
    RAISE EXCEPTION 'a photo can have at most 20 tags' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_photos_before_write ON job_photos;
CREATE TRIGGER trg_job_photos_before_write
  BEFORE INSERT OR UPDATE ON job_photos
  FOR EACH ROW EXECUTE FUNCTION public.job_photos_before_write();

DROP TRIGGER IF EXISTS trg_job_photos_updated_at ON job_photos;
CREATE TRIGGER trg_job_photos_updated_at
  BEFORE UPDATE ON job_photos
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE OR REPLACE FUNCTION public.job_photos_after_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.log_audit_event(OLD.user_id, 'job_photo_deleted', 'job_photos', OLD.id::text);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_photos_after_delete ON job_photos;
CREATE TRIGGER trg_job_photos_after_delete
  AFTER DELETE ON job_photos
  FOR EACH ROW EXECUTE FUNCTION public.job_photos_after_delete();

ALTER TABLE job_photos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_job_photos" ON job_photos;
CREATE POLICY "select_account_job_photos" ON job_photos FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- Any account member can upload; they must record themselves as the uploader.
DROP POLICY IF EXISTS "insert_account_job_photos" ON job_photos;
CREATE POLICY "insert_account_job_photos" ON job_photos FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND uploaded_by = auth.uid());

DROP POLICY IF EXISTS "update_account_job_photos" ON job_photos;
CREATE POLICY "update_account_job_photos" ON job_photos FOR UPDATE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (public.can_manage_job_photos() OR uploaded_by = auth.uid())
  )
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND (public.can_manage_job_photos() OR uploaded_by = auth.uid())
  );

DROP POLICY IF EXISTS "delete_account_job_photos" ON job_photos;
CREATE POLICY "delete_account_job_photos" ON job_photos FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_job_photos());

-- =============================================================
-- BEFORE / AFTER PAIRING (SECURITY INVOKER: RLS decides what you may touch)
-- =============================================================
CREATE OR REPLACE FUNCTION public.pair_job_photos(p_before uuid, p_after uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_pair uuid := gen_random_uuid();
  v_n integer;
  v_jobs integer;
BEGIN
  IF p_before IS NULL OR p_after IS NULL OR p_before = p_after THEN
    RAISE EXCEPTION 'choose one before photo and one different after photo' USING ERRCODE = '22023';
  END IF;

  -- A pair must belong to one job (or both be unassigned).
  SELECT count(*) INTO v_jobs
  FROM (SELECT DISTINCT job_id FROM job_photos WHERE id IN (p_before, p_after)) s;
  IF v_jobs > 1 THEN
    RAISE EXCEPTION 'before and after photos must belong to the same job' USING ERRCODE = '22023';
  END IF;

  -- Dissolve any pair either photo already belongs to.
  UPDATE job_photos SET pair_id = NULL
  WHERE pair_id IN (SELECT pair_id FROM job_photos WHERE id IN (p_before, p_after) AND pair_id IS NOT NULL);

  UPDATE job_photos SET pair_id = v_pair
  WHERE (id = p_before AND kind = 'before') OR (id = p_after AND kind = 'after');
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n <> 2 THEN
    RAISE EXCEPTION 'pairing needs one "before" and one "after" photo that you are allowed to edit' USING ERRCODE = '42501';
  END IF;
  RETURN v_pair;
END;
$$;

CREATE OR REPLACE FUNCTION public.unpair_job_photo(p_photo uuid)
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  UPDATE job_photos SET pair_id = NULL
  WHERE pair_id = (SELECT pair_id FROM job_photos WHERE id = p_photo);
$$;

REVOKE ALL ON FUNCTION public.pair_job_photos(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unpair_job_photo(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pair_job_photos(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unpair_job_photo(uuid) TO authenticated;

-- =============================================================
-- STORAGE: private bucket, folder = account owner id
-- Layout: <owner>/<photo_id>.<ext>  and  <owner>/<photo_id>-thumb.jpg
-- =============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'job-photos',
  'job-photos',
  false,
  15728640, -- 15 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "job_photos_read_account" ON storage.objects;
CREATE POLICY "job_photos_read_account" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'job-photos' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);

DROP POLICY IF EXISTS "job_photos_insert_member" ON storage.objects;
CREATE POLICY "job_photos_insert_member" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'job-photos' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);

DROP POLICY IF EXISTS "job_photos_delete_manager" ON storage.objects;
CREATE POLICY "job_photos_delete_manager" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'job-photos'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.can_manage_job_photos()
  );

-- A member may remove an object THEY uploaded that never got a database row
-- (rollback of a failed upload) — but never one that is referenced by a photo.
DROP POLICY IF EXISTS "job_photos_delete_orphan_own" ON storage.objects;
CREATE POLICY "job_photos_delete_orphan_own" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'job-photos'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND owner = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM job_photos jp WHERE jp.storage_path = name OR jp.thumb_path = name
    )
  );
