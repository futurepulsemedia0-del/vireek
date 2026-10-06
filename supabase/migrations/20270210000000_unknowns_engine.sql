/*
  # Vireek Unknowns Engine

  Per-job epistemic state: for every decision dimension (diagnosis, equipment identity,
  part compatibility, site condition, permit requirement, scope & price) the client engine
  (src/lib/unknownsEngine.ts) computes Known / Likely / Uncertain / Unknown / Contradictory /
  Unverified from data that already exists. Nothing is invented server-side.

  This migration only stores the HUMAN part of the loop:
  - job_unknown_resolutions : one row per (job, dimension) when a person verifies an unknown
      ('verified' + what was confirmed) or knowingly accepts the risk ('waived' + reason).
      Author / timestamp / account owner are set by a trigger, never trusted from the client.
  - job_unknown_events      : append-only audit trail (verified / waived / reopened).
      No insert/update/delete policy exists for clients; only the SECURITY DEFINER trigger writes.

  Additive only: no existing table, column or policy is touched.
  Requires: jobs, public.get_account_owner_id().
*/

-- =============================================================
-- 1. RESOLUTIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.job_unknown_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  dimension text NOT NULL CHECK (dimension IN (
    'diagnosis', 'equipment_identity', 'part_compatibility',
    'site_condition', 'permit_requirement', 'scope_and_price'
  )),
  resolution text NOT NULL CHECK (resolution IN ('verified', 'waived')),
  value text CHECK (value IS NULL OR char_length(value) <= 300),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  resolved_by uuid NOT NULL DEFAULT auth.uid(),
  resolved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, dimension),
  CONSTRAINT job_unknown_resolution_content CHECK (
    (resolution = 'verified' AND char_length(btrim(coalesce(value, ''))) >= 2)
    OR (resolution = 'waived' AND char_length(btrim(coalesce(note, ''))) >= 10)
  )
);

CREATE INDEX IF NOT EXISTS idx_job_unknown_resolutions_owner ON public.job_unknown_resolutions (user_id);

ALTER TABLE public.job_unknown_resolutions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_job_unknown_resolutions" ON public.job_unknown_resolutions;
CREATE POLICY "select_own_job_unknown_resolutions" ON public.job_unknown_resolutions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_job_unknown_resolutions" ON public.job_unknown_resolutions;
CREATE POLICY "insert_own_job_unknown_resolutions" ON public.job_unknown_resolutions
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_job_unknown_resolutions" ON public.job_unknown_resolutions;
CREATE POLICY "update_own_job_unknown_resolutions" ON public.job_unknown_resolutions
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_job_unknown_resolutions" ON public.job_unknown_resolutions;
CREATE POLICY "delete_own_job_unknown_resolutions" ON public.job_unknown_resolutions
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

-- Server-authoritative fields. Runs as the caller, so jobs RLS decides whether the job is visible
-- (a technician who cannot see a job cannot resolve unknowns on it).
CREATE OR REPLACE FUNCTION public.job_unknown_resolutions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  SELECT j.user_id INTO v_owner FROM public.jobs j WHERE j.id = NEW.job_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Job not found or not accessible' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND (NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.dimension IS DISTINCT FROM OLD.dimension) THEN
    RAISE EXCEPTION 'job_id and dimension are immutable' USING ERRCODE = '23514';
  END IF;

  NEW.user_id := v_owner;
  NEW.resolved_by := auth.uid();
  NEW.resolved_at := now();
  NEW.value := nullif(btrim(coalesce(NEW.value, '')), '');
  NEW.note := nullif(btrim(coalesce(NEW.note, '')), '');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_unknown_resolutions_guard ON public.job_unknown_resolutions;
CREATE TRIGGER trg_job_unknown_resolutions_guard
  BEFORE INSERT OR UPDATE ON public.job_unknown_resolutions
  FOR EACH ROW EXECUTE FUNCTION public.job_unknown_resolutions_guard();

-- =============================================================
-- 2. APPEND-ONLY AUDIT TRAIL
-- =============================================================

CREATE TABLE IF NOT EXISTS public.job_unknown_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  dimension text NOT NULL,
  action text NOT NULL CHECK (action IN ('verified', 'waived', 'reopened')),
  value text,
  note text,
  actor uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_unknown_events_job ON public.job_unknown_events (job_id, created_at DESC);

ALTER TABLE public.job_unknown_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_job_unknown_events" ON public.job_unknown_events;
CREATE POLICY "select_own_job_unknown_events" ON public.job_unknown_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- Intentionally no INSERT / UPDATE / DELETE policy: only the trigger below writes here.

CREATE OR REPLACE FUNCTION public.job_unknown_resolutions_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.job_unknown_events (user_id, job_id, dimension, action, value, note, actor)
    VALUES (OLD.user_id, OLD.job_id, OLD.dimension, 'reopened', OLD.value, OLD.note, auth.uid());
    RETURN OLD;
  END IF;

  INSERT INTO public.job_unknown_events (user_id, job_id, dimension, action, value, note, actor)
  VALUES (NEW.user_id, NEW.job_id, NEW.dimension, NEW.resolution, NEW.value, NEW.note, NEW.resolved_by);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.job_unknown_resolutions_audit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_job_unknown_resolutions_audit ON public.job_unknown_resolutions;
CREATE TRIGGER trg_job_unknown_resolutions_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.job_unknown_resolutions
  FOR EACH ROW EXECUTE FUNCTION public.job_unknown_resolutions_audit();

COMMENT ON TABLE public.job_unknown_resolutions IS
  'Human resolution of an engine-computed unknown on a job (verified with what was confirmed, or waived with a reason). Author/time/owner are trigger-set.';
COMMENT ON TABLE public.job_unknown_events IS
  'Append-only audit trail of unknown resolutions (verified / waived / reopened). Written only by trigger.';
