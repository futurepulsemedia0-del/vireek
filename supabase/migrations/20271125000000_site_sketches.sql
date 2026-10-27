/*
  # Site sketches — on-site sketch & measure tool

  Floor plans / room dimensions drawn on a phone, attachable to a job and/or quote.
  The drawing is a validated JSON document (coordinates in integer millimetres).

  ## Access
  - Owner and managers (effective can_view_all_jobs): every sketch in the account.
  - Technicians: sketches they created, plus sketches attached to jobs assigned to them.
  - Attaching to a QUOTE needs a manager. Attaching to a JOB needs a manager or the assigned technician.
  - No client INSERT/UPDATE/DELETE policies: writes only via the RPCs below.
  - save_site_sketch uses optimistic concurrency (revision) so two devices cannot silently overwrite each other.
*/

-- =============================================================
-- Helpers
-- =============================================================
CREATE OR REPLACE FUNCTION public.sketch_is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
    AND public.get_account_owner_id() IS NOT NULL
    AND (
      auth.uid() = public.get_account_owner_id()
      OR EXISTS (
        SELECT 1
          FROM public.team_members m
          LEFT JOIN public.custom_roles cr ON cr.id = m.custom_role_id
         WHERE m.user_id = auth.uid()
           AND m.account_owner_id = public.get_account_owner_id()
           AND m.invite_status = 'active'
           AND COALESCE(
                 (cr.permissions ->> 'can_view_all_jobs')::boolean,
                 (m.permissions ->> 'can_view_all_jobs')::boolean,
                 false
               )
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.sketch_is_assigned_tech(p_job_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_job_id IS NOT NULL
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM public.jobs j
        JOIN public.team_members m ON m.id = j.assigned_technician_id
       WHERE j.id = p_job_id
         AND j.user_id = public.get_account_owner_id()
         AND m.user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION public.sketch_can_access(p_owner uuid, p_created_by uuid, p_job_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
    AND p_owner IS NOT DISTINCT FROM public.get_account_owner_id()
    AND (
      public.sketch_is_manager()
      OR p_created_by = auth.uid()
      OR public.sketch_is_assigned_tech(p_job_id)
    );
$$;

-- =============================================================
-- Table
-- =============================================================
CREATE TABLE IF NOT EXISTS public.site_sketches (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  title text NOT NULL DEFAULT 'Untitled sketch' CHECK (char_length(title) BETWEEN 1 AND 120),
  unit text NOT NULL DEFAULT 'imperial' CHECK (unit IN ('imperial', 'metric')),
  doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND octet_length(doc::text) <= 524288),
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  quote_id uuid REFERENCES public.quotes(id) ON DELETE SET NULL,
  area_mm2 bigint NOT NULL DEFAULT 0 CHECK (area_mm2 BETWEEN 0 AND 10000000000000),
  wall_mm bigint NOT NULL DEFAULT 0 CHECK (wall_mm BETWEEN 0 AND 10000000000),
  thumb text CHECK (thumb IS NULL OR char_length(thumb) <= 8000),
  revision integer NOT NULL DEFAULT 1,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_sketches_user_updated ON public.site_sketches (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_sketches_job ON public.site_sketches (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_site_sketches_quote ON public.site_sketches (quote_id) WHERE quote_id IS NOT NULL;

ALTER TABLE public.site_sketches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_site_sketches" ON public.site_sketches;
CREATE POLICY "select_site_sketches" ON public.site_sketches FOR SELECT TO authenticated
  USING (public.sketch_can_access(user_id, created_by, job_id));
-- No client INSERT/UPDATE/DELETE — only the RPCs below.

-- =============================================================
-- RPC: save_site_sketch (create or update, optimistic concurrency)
-- =============================================================
CREATE OR REPLACE FUNCTION public.save_site_sketch(
  p_id uuid,
  p_title text,
  p_doc jsonb,
  p_job_id uuid DEFAULT NULL,
  p_quote_id uuid DEFAULT NULL,
  p_area_mm2 bigint DEFAULT 0,
  p_wall_mm bigint DEFAULT 0,
  p_thumb text DEFAULT NULL,
  p_unit text DEFAULT 'imperial',
  p_expected_revision integer DEFAULT NULL
)
RETURNS TABLE (sketch_id uuid, revision_no integer, saved_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_uid uuid := auth.uid();
  v_manager boolean;
  v_title text := left(COALESCE(NULLIF(btrim(p_title), ''), 'Untitled sketch'), 120);
  v_unit text := CASE WHEN p_unit = 'metric' THEN 'metric' ELSE 'imperial' END;
  v_row public.site_sketches%ROWTYPE;
  v_found boolean := false;
  v_rev integer;
  v_at timestamptz := now();
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Sketch id is required';
  END IF;
  IF p_doc IS NULL OR jsonb_typeof(p_doc) <> 'object' THEN
    RAISE EXCEPTION 'Sketch data is invalid';
  END IF;
  IF octet_length(p_doc::text) > 524288 THEN
    RAISE EXCEPTION 'This sketch is too large to save';
  END IF;

  v_manager := public.sketch_is_manager();

  SELECT * INTO v_row FROM public.site_sketches s WHERE s.id = p_id FOR UPDATE;
  v_found := FOUND;

  IF v_found THEN
    IF v_row.user_id <> v_owner OR NOT public.sketch_can_access(v_row.user_id, v_row.created_by, v_row.job_id) THEN
      RAISE EXCEPTION 'Sketch not found or not authorized' USING ERRCODE = '42501';
    END IF;
    IF p_expected_revision IS NOT NULL AND v_row.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'This sketch was changed on another device' USING ERRCODE = 'SK409';
    END IF;
  END IF;

  -- Job link: must belong to this account; non-managers only for their assigned jobs.
  IF p_job_id IS NOT NULL AND (NOT v_found OR v_row.job_id IS DISTINCT FROM p_job_id) THEN
    IF NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p_job_id AND j.user_id = v_owner) THEN
      RAISE EXCEPTION 'Job not found';
    END IF;
    IF NOT v_manager AND NOT public.sketch_is_assigned_tech(p_job_id) THEN
      RAISE EXCEPTION 'You can only attach sketches to jobs assigned to you' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Quote link: managers only.
  IF (p_quote_id IS NOT NULL AND (NOT v_found OR v_row.quote_id IS DISTINCT FROM p_quote_id))
     OR (v_found AND v_row.quote_id IS NOT NULL AND p_quote_id IS NULL) THEN
    IF NOT v_manager THEN
      RAISE EXCEPTION 'Only managers can change which quote a sketch is attached to' USING ERRCODE = '42501';
    END IF;
    IF p_quote_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.quotes q WHERE q.id = p_quote_id AND q.user_id = v_owner) THEN
      RAISE EXCEPTION 'Quote not found';
    END IF;
  END IF;

  IF v_found THEN
    UPDATE public.site_sketches s SET
      title = v_title,
      unit = v_unit,
      doc = p_doc,
      job_id = p_job_id,
      quote_id = p_quote_id,
      area_mm2 = GREATEST(0, LEAST(COALESCE(p_area_mm2, 0), 10000000000000)),
      wall_mm = GREATEST(0, LEAST(COALESCE(p_wall_mm, 0), 10000000000)),
      thumb = CASE WHEN p_thumb IS NOT NULL AND char_length(p_thumb) <= 8000 THEN p_thumb ELSE NULL END,
      revision = s.revision + 1,
      updated_by = v_uid,
      updated_at = v_at
    WHERE s.id = p_id
    RETURNING s.revision INTO v_rev;
  ELSE
    INSERT INTO public.site_sketches AS s
      (id, user_id, title, unit, doc, job_id, quote_id, area_mm2, wall_mm, thumb, revision, created_by, updated_by, created_at, updated_at)
    VALUES
      (p_id, v_owner, v_title, v_unit, p_doc, p_job_id, p_quote_id,
       GREATEST(0, LEAST(COALESCE(p_area_mm2, 0), 10000000000000)),
       GREATEST(0, LEAST(COALESCE(p_wall_mm, 0), 10000000000)),
       CASE WHEN p_thumb IS NOT NULL AND char_length(p_thumb) <= 8000 THEN p_thumb ELSE NULL END,
       1, v_uid, v_uid, v_at, v_at)
    RETURNING s.revision INTO v_rev;
  END IF;

  RETURN QUERY SELECT p_id, v_rev, v_at;
END;
$$;

-- =============================================================
-- RPC: delete_site_sketch
-- =============================================================
CREATE OR REPLACE FUNCTION public.delete_site_sketch(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_uid uuid := auth.uid();
  v_row public.site_sketches%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO v_row FROM public.site_sketches s WHERE s.id = p_id AND s.user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sketch not found or not authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT public.sketch_is_manager() AND v_row.created_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only managers or the creator can delete this sketch' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.site_sketches s WHERE s.id = p_id AND s.user_id = v_owner;
END;
$$;

-- =============================================================
-- Grants
-- =============================================================
REVOKE ALL ON FUNCTION public.sketch_is_manager() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sketch_is_assigned_tech(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sketch_can_access(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_site_sketch(uuid, text, jsonb, uuid, uuid, bigint, bigint, text, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_site_sketch(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.sketch_is_manager() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sketch_is_assigned_tech(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sketch_can_access(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_site_sketch(uuid, text, jsonb, uuid, uuid, bigint, bigint, text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_site_sketch(uuid) TO authenticated;
GRANT SELECT ON public.site_sketches TO authenticated;
