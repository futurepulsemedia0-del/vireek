/*
  # Status / stage engine (Phase 1) — per-business custom job statuses

  `jobs.job_status` keeps ONLY the 11 canonical values (6 legacy + 5 workflow), so reports,
  AI engines, RLS, partial indexes and the public API keep working unchanged.
  A business-defined status is a *label layer* on top: jobs.custom_status_id -> status_definitions,
  and every definition maps to exactly one canonical status.

  Invariant (enforced by triggers): custom_status_id IS NULL
     OR (definition belongs to the job's account AND definition.canonical_status = jobs.job_status).
  Any legacy write that changes job_status silently clears a stale custom_status_id.
  A job with custom_status_id NULL behaves exactly as before — existing rows need NO backfill.

  ## Tables
  1. status_definitions          — per-account, versioned, archive-only (no DELETE policy)
  2. status_definition_versions  — snapshot of every replaced version (schema-change audit)
  3. status_transitions          — who may move from -> to, note requirement (no rows = unrestricted)

  ## Functions
  - ensure_status_definitions()  — idempotent seed of the 11 system definitions for the caller's account
  - move_job_to_status(...)      — the supported way to apply a definition (rules + reuse of
                                    set_job_workflow_status / resume_job_from_workflow + job_holds SLA)

  ## Rollback
  Safe to leave in place. To disable only the enforcement:
    DROP TRIGGER trg_jobs_custom_status_guard_ins ON jobs;
    DROP TRIGGER trg_jobs_custom_status_guard_upd ON jobs;
*/

-- =============================================================
-- 1. Definitions
-- =============================================================
CREATE TABLE IF NOT EXISTS public.status_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  scope text NOT NULL DEFAULT 'job' CHECK (scope = 'job'),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  label_i18n jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(label_i18n) = 'object' AND pg_column_size(label_i18n) <= 4096),
  color text NOT NULL DEFAULT 'neutral'
    CHECK (color IN ('neutral', 'info', 'success', 'warning', 'danger', 'accent', 'orange')),
  canonical_status text NOT NULL CHECK (canonical_status IN (
    'scheduled', 'en_route', 'in_progress', 'completed', 'cancelled', 'no_show',
    'on_hold', 'waiting_on_parts', 'waiting_on_customer', 'needs_follow_up', 'return_visit_needed'
  )),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 10000),
  is_system boolean NOT NULL DEFAULT false,
  requires_note boolean NOT NULL DEFAULT false,
  required_fields text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (
      cardinality(required_fields) <= 10
      AND array_to_string(required_fields, ',') ~ '^([a-z][a-z0-9_]{0,39}(,[a-z][a-z0-9_]{0,39})*)?$'
    ),
  -- SLA timer: only meaningful when the canonical status already owns a job_holds timer.
  sla_minutes integer
    CHECK (sla_minutes IS NULL OR (
      sla_minutes BETWEEN 5 AND 525600
      AND public.is_job_workflow_status(canonical_status)
    )),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope, key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_status_definitions_label
  ON public.status_definitions (user_id, scope, lower(btrim(label)))
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_status_definitions_user_scope
  ON public.status_definitions (user_id, scope, sort_order)
  WHERE archived_at IS NULL;

ALTER TABLE public.status_definitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_status_definitions" ON public.status_definitions;
CREATE POLICY "select_status_definitions" ON public.status_definitions FOR SELECT TO authenticated
USING (user_id = (select public.get_account_owner_id()));

DROP POLICY IF EXISTS "insert_status_definitions" ON public.status_definitions;
CREATE POLICY "insert_status_definitions" ON public.status_definitions FOR INSERT TO authenticated
WITH CHECK (user_id = (select auth.uid()) AND user_id = (select public.get_account_owner_id()) AND is_system = false);

DROP POLICY IF EXISTS "update_status_definitions" ON public.status_definitions;
CREATE POLICY "update_status_definitions" ON public.status_definitions FOR UPDATE TO authenticated
USING (user_id = (select auth.uid()) AND user_id = (select public.get_account_owner_id()))
WITH CHECK (user_id = (select auth.uid()) AND user_id = (select public.get_account_owner_id()));
-- Intentionally NO delete policy: definitions are archived, never deleted.

-- =============================================================
-- 2. Version history (schema-change audit)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.status_definition_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id uuid NOT NULL REFERENCES public.status_definitions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (definition_id, version)
);

ALTER TABLE public.status_definition_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_status_definition_versions" ON public.status_definition_versions;
CREATE POLICY "select_status_definition_versions" ON public.status_definition_versions FOR SELECT TO authenticated
USING (user_id = (select public.get_account_owner_id()));
-- Writes happen only through the SECURITY DEFINER trigger below.

CREATE OR REPLACE FUNCTION public.status_definitions_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_system = false AND (
      SELECT count(*) FROM status_definitions
       WHERE user_id = NEW.user_id AND scope = NEW.scope AND archived_at IS NULL
    ) >= 40 THEN
      RAISE EXCEPTION 'STATUS_DEFINITION_LIMIT: at most 40 active statuses per account.' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.user_id <> OLD.user_id OR NEW.scope <> OLD.scope OR NEW.key <> OLD.key
     OR NEW.is_system <> OLD.is_system THEN
    RAISE EXCEPTION 'A status definition''s key, scope, owner and system flag cannot be changed.' USING ERRCODE = '22023';
  END IF;
  IF OLD.is_system AND NEW.canonical_status <> OLD.canonical_status THEN
    RAISE EXCEPTION 'A system status cannot be remapped.' USING ERRCODE = '22023';
  END IF;
  IF OLD.is_system AND NEW.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'A system status cannot be archived.' USING ERRCODE = '22023';
  END IF;
  -- Re-mapping a status that jobs already use would silently change their canonical state.
  IF NEW.canonical_status <> OLD.canonical_status AND EXISTS (
    SELECT 1 FROM jobs WHERE custom_status_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'STATUS_REMAP_IN_USE: archive this status and create a new one instead.' USING ERRCODE = '22023';
  END IF;
  -- Restoring into a label that is now taken is caught by uq_status_definitions_label.

  IF (NEW.label, NEW.label_i18n, NEW.color, NEW.canonical_status, NEW.requires_note,
      NEW.required_fields, NEW.sla_minutes, NEW.archived_at)
     IS DISTINCT FROM
     (OLD.label, OLD.label_i18n, OLD.color, OLD.canonical_status, OLD.requires_note,
      OLD.required_fields, OLD.sla_minutes, OLD.archived_at) THEN
    INSERT INTO status_definition_versions (definition_id, user_id, version, snapshot, changed_by)
    VALUES (OLD.id, OLD.user_id, OLD.version, to_jsonb(OLD), auth.uid())
    ON CONFLICT (definition_id, version) DO NOTHING;
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_status_definitions_before_write ON public.status_definitions;
CREATE TRIGGER trg_status_definitions_before_write
  BEFORE INSERT OR UPDATE ON public.status_definitions
  FOR EACH ROW EXECUTE FUNCTION public.status_definitions_before_write();

CREATE OR REPLACE FUNCTION public.status_definitions_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_system AND TG_OP = 'INSERT' THEN
    RETURN NEW; -- seeding is not a user change
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version THEN
    RETURN NEW; -- cosmetic no-op (e.g. sort_order only)
  END IF;
  PERFORM public.log_audit_event(
    NEW.user_id,
    CASE WHEN TG_OP = 'INSERT' THEN 'status_definition_created'
         WHEN NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN 'status_definition_archived'
         ELSE 'status_definition_updated' END,
    'status_definitions', NEW.id::text,
    jsonb_build_object('key', NEW.key, 'canonical_status', NEW.canonical_status, 'version', NEW.version)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_status_definitions_audit ON public.status_definitions;
CREATE TRIGGER trg_status_definitions_audit
  AFTER INSERT OR UPDATE ON public.status_definitions
  FOR EACH ROW EXECUTE FUNCTION public.status_definitions_audit();

-- =============================================================
-- 3. Transition rules (no rows for an account = unrestricted, i.e. today's behavior)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.status_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  scope text NOT NULL DEFAULT 'job' CHECK (scope = 'job'),
  from_definition_id uuid REFERENCES public.status_definitions(id) ON DELETE CASCADE,
  to_definition_id uuid NOT NULL REFERENCES public.status_definitions(id) ON DELETE CASCADE,
  allowed_roles text[] NOT NULL DEFAULT ARRAY['owner', 'admin', 'member', 'technician']::text[]
    CHECK (
      cardinality(allowed_roles) BETWEEN 1 AND 4
      AND allowed_roles <@ ARRAY['owner', 'admin', 'member', 'technician']::text[]
    ),
  requires_note boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_status_transitions_pair
  ON public.status_transitions (to_definition_id, COALESCE(from_definition_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS idx_status_transitions_user
  ON public.status_transitions (user_id, scope);

ALTER TABLE public.status_transitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_status_transitions" ON public.status_transitions;
CREATE POLICY "select_status_transitions" ON public.status_transitions FOR SELECT TO authenticated
USING (user_id = (select public.get_account_owner_id()));

DROP POLICY IF EXISTS "insert_status_transitions" ON public.status_transitions;
CREATE POLICY "insert_status_transitions" ON public.status_transitions FOR INSERT TO authenticated
WITH CHECK (
  user_id = (select auth.uid()) AND user_id = (select public.get_account_owner_id())
  AND EXISTS (SELECT 1 FROM public.status_definitions d WHERE d.id = to_definition_id AND d.user_id = status_transitions.user_id)
  AND (from_definition_id IS NULL OR EXISTS (
    SELECT 1 FROM public.status_definitions d WHERE d.id = from_definition_id AND d.user_id = status_transitions.user_id))
);

DROP POLICY IF EXISTS "update_status_transitions" ON public.status_transitions;
CREATE POLICY "update_status_transitions" ON public.status_transitions FOR UPDATE TO authenticated
USING (user_id = (select auth.uid()) AND user_id = (select public.get_account_owner_id()))
WITH CHECK (user_id = (select auth.uid()) AND user_id = (select public.get_account_owner_id()));

DROP POLICY IF EXISTS "delete_status_transitions" ON public.status_transitions;
CREATE POLICY "delete_status_transitions" ON public.status_transitions FOR DELETE TO authenticated
USING (user_id = (select auth.uid()) AND user_id = (select public.get_account_owner_id()));

-- =============================================================
-- 4. jobs.custom_status_id + invariant guard
-- =============================================================
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS custom_status_id uuid
  REFERENCES public.status_definitions(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_jobs_custom_status_id
  ON public.jobs (custom_status_id) WHERE custom_status_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.jobs_custom_status_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_def status_definitions%ROWTYPE;
BEGIN
  IF NEW.custom_status_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_def FROM status_definitions WHERE id = NEW.custom_status_id;
  IF NOT FOUND OR v_def.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'STATUS_DEFINITION_INVALID: unknown status for this account.' USING ERRCODE = '22023';
  END IF;

  -- Only job_status moved: a legacy writer changed the canonical state -> drop the stale label.
  IF TG_OP = 'UPDATE' AND NEW.custom_status_id IS NOT DISTINCT FROM OLD.custom_status_id THEN
    IF v_def.canonical_status <> NEW.job_status THEN
      NEW.custom_status_id := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- A label is being assigned/changed.
  IF v_def.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'STATUS_DEFINITION_ARCHIVED: this status is archived.' USING ERRCODE = '22023';
  END IF;
  IF v_def.canonical_status <> NEW.job_status THEN
    RAISE EXCEPTION 'STATUS_DEFINITION_MISMATCH: use move_job_to_status() to change a job''s status.' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jobs_custom_status_guard_ins ON public.jobs;
CREATE TRIGGER trg_jobs_custom_status_guard_ins
  BEFORE INSERT ON public.jobs
  FOR EACH ROW WHEN (NEW.custom_status_id IS NOT NULL)
  EXECUTE FUNCTION public.jobs_custom_status_guard();

DROP TRIGGER IF EXISTS trg_jobs_custom_status_guard_upd ON public.jobs;
CREATE TRIGGER trg_jobs_custom_status_guard_upd
  BEFORE UPDATE OF job_status, custom_status_id ON public.jobs
  FOR EACH ROW WHEN (NEW.custom_status_id IS NOT NULL)
  EXECUTE FUNCTION public.jobs_custom_status_guard();

-- =============================================================
-- 5. Seed the 11 system definitions (idempotent)
-- =============================================================
CREATE OR REPLACE FUNCTION public.seed_status_definitions(p_user_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO status_definitions (user_id, scope, key, label, color, canonical_status, sort_order, is_system)
  SELECT p_user_id, 'job', d.k, d.lbl, d.col, d.k, d.ord, true
  FROM (VALUES
    ('scheduled',           'Scheduled',           'info',    10),
    ('en_route',            'En route',            'accent',  20),
    ('in_progress',         'In progress',         'warning', 30),
    ('completed',           'Completed',           'success', 40),
    ('cancelled',           'Cancelled',           'danger',  50),
    ('no_show',             'No show',             'neutral', 60),
    ('on_hold',             'On hold',             'neutral', 70),
    ('waiting_on_parts',    'Waiting on parts',    'orange',  80),
    ('waiting_on_customer', 'Waiting on customer', 'info',    90),
    ('needs_follow_up',     'Needs follow-up',     'warning', 100),
    ('return_visit_needed', 'Return visit needed', 'accent',  110)
  ) AS d(k, lbl, col, ord)
  ON CONFLICT DO NOTHING;
$$;

REVOKE ALL ON FUNCTION public.seed_status_definitions(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.ensure_status_definitions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  PERFORM public.seed_status_definitions(v_owner);
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_status_definitions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_status_definitions() TO authenticated;

-- =============================================================
-- 6. move_job_to_status — the supported way to apply a definition
-- =============================================================
CREATE OR REPLACE FUNCTION public.move_job_to_status(
  p_job_id uuid,
  p_definition_id uuid,
  p_reason_code text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_expected_resume_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_job jobs%ROWTYPE;
  v_def status_definitions%ROWTYPE;
  v_role text := 'owner';
  v_view_all boolean := false;
  v_member_id uuid;
  v_is_member boolean := false;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_cur_def_id uuid;
  v_rule_count integer;
  v_rule status_transitions%ROWTYPE;
  v_rule_found boolean := false;
  v_missing text[];
  v_res jsonb;
  v_prev_status text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'Note is too long (max 1000 characters).');
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'reason', 'Job not found.');
  END IF;
  IF v_job.user_id IS DISTINCT FROM public.get_account_owner_id() THEN
    RAISE EXCEPTION 'Not authorized for this job';
  END IF;

  IF v_uid IS DISTINCT FROM v_job.user_id THEN
    v_role := 'member';
    SELECT tm.role, COALESCE((tm.permissions->>'can_view_all_jobs')::boolean, false), tm.id, true
      INTO v_role, v_view_all, v_member_id, v_is_member
      FROM team_members tm
     WHERE tm.account_owner_id = v_job.user_id
       AND tm.member_email = (SELECT email FROM auth.users WHERE id = v_uid)
     LIMIT 1;
    IF v_is_member IS NOT TRUE THEN
      RAISE EXCEPTION 'Not authorized for this job';
    END IF;
    IF v_role = 'technician' AND v_view_all IS NOT TRUE
       AND v_job.assigned_technician_id IS DISTINCT FROM v_member_id THEN
      RETURN jsonb_build_object('status', 'forbidden', 'reason', 'You can only update jobs assigned to you.');
    END IF;
  END IF;

  SELECT * INTO v_def FROM status_definitions
   WHERE id = p_definition_id AND user_id = v_job.user_id AND scope = 'job';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'reason', 'Status not found.');
  END IF;
  IF v_def.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'archived', 'reason', 'This status is archived.');
  END IF;

  v_cur_def_id := COALESCE(
    v_job.custom_status_id,
    (SELECT id FROM status_definitions
      WHERE user_id = v_job.user_id AND scope = 'job' AND is_system AND key = v_job.job_status)
  );
  IF v_cur_def_id IS NOT DISTINCT FROM p_definition_id THEN
    RETURN jsonb_build_object('status', 'unchanged', 'reason', 'Job is already in this status.');
  END IF;

  -- Transition rules. No rules configured for the account = unrestricted (legacy behavior).
  SELECT count(*) INTO v_rule_count FROM status_transitions WHERE user_id = v_job.user_id AND scope = 'job';
  IF v_rule_count > 0 THEN
    SELECT t.* INTO v_rule
      FROM status_transitions t
     WHERE t.user_id = v_job.user_id AND t.scope = 'job'
       AND t.to_definition_id = p_definition_id
       AND (t.from_definition_id = v_cur_def_id OR t.from_definition_id IS NULL)
       AND (v_role = 'owner' OR v_role = ANY (t.allowed_roles))
     ORDER BY (t.from_definition_id IS NOT NULL) DESC
     LIMIT 1;
    v_rule_found := FOUND;
    IF NOT v_rule_found THEN
      RETURN jsonb_build_object('status', 'transition_not_allowed',
                                'reason', 'This move isn''t allowed for your role or from the current status.');
    END IF;
  END IF;

  IF (v_def.requires_note OR (v_rule_found AND v_rule.requires_note))
     AND (v_note IS NULL OR length(v_note) < 3) THEN
    RETURN jsonb_build_object('status', 'note_required', 'reason', 'Add a short note to make this move.');
  END IF;

  IF cardinality(v_def.required_fields) > 0 THEN
    SELECT COALESCE(array_agg(f ORDER BY f), '{}'::text[]) INTO v_missing
      FROM unnest(v_def.required_fields) AS f
     WHERE COALESCE(btrim(COALESCE(v_job.custom_data, '{}'::jsonb) ->> f), '') = '';
    IF cardinality(v_missing) > 0 THEN
      RETURN jsonb_build_object('status', 'missing_fields', 'reason', 'Required fields are missing.',
                                'fields', to_jsonb(v_missing));
    END IF;
  END IF;

  v_prev_status := v_job.job_status;

  IF v_def.canonical_status <> v_job.job_status THEN
    IF public.is_job_workflow_status(v_def.canonical_status) THEN
      IF p_reason_code IS NULL THEN
        RETURN jsonb_build_object('status', 'reason_required', 'reason', 'Choose a reason for this status.');
      END IF;
      v_res := public.set_job_workflow_status(p_job_id, v_def.canonical_status, p_reason_code, v_note, p_expected_resume_at);
      IF v_res->>'status' NOT IN ('ok', 'unchanged') THEN
        RETURN v_res;
      END IF;
      IF v_def.sla_minutes IS NOT NULL THEN
        UPDATE job_holds
           SET sla_minutes = v_def.sla_minutes,
               sla_due_at = started_at + make_interval(mins => v_def.sla_minutes)
         WHERE job_id = p_job_id AND resolved_at IS NULL;
      END IF;
    ELSIF public.is_job_workflow_status(v_job.job_status)
          AND v_def.canonical_status IN ('scheduled', 'en_route', 'in_progress') THEN
      v_res := public.resume_job_from_workflow(p_job_id, v_def.canonical_status, v_note);
      IF v_res->>'status' <> 'ok' THEN
        RETURN v_res;
      END IF;
    ELSE
      UPDATE jobs SET job_status = v_def.canonical_status WHERE id = p_job_id;
      INSERT INTO job_status_events (job_id, technician_id, from_status, to_status, note)
      VALUES (p_job_id, v_job.assigned_technician_id, v_prev_status, v_def.canonical_status, v_note);
    END IF;
  END IF;

  -- System definitions are represented by NULL (the legacy shape); custom ones by their id.
  UPDATE jobs
     SET custom_status_id = CASE WHEN v_def.is_system THEN NULL ELSE v_def.id END
   WHERE id = p_job_id;

  PERFORM public.log_audit_event(
    v_job.user_id, 'job_status_moved', 'jobs', p_job_id::text,
    jsonb_build_object('definition_key', v_def.key, 'definition_version', v_def.version,
                       'from_status', v_prev_status, 'to_status', v_def.canonical_status)
  );

  RETURN jsonb_build_object('status', 'ok', 'job_status', v_def.canonical_status,
                            'definition_id', v_def.id, 'definition_version', v_def.version);
END;
$$;

REVOKE ALL ON FUNCTION public.move_job_to_status(uuid, uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.move_job_to_status(uuid, uuid, text, text, timestamptz) TO authenticated;
