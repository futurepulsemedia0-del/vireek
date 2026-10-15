/*
  # Call Scripts — per-scenario AI scripts, versions, A/B variants

  ## Why
  The phone assistant's behaviour per situation (emergency, price question,
  reschedule, complaint ...) lived only in one big prompt inside the Vapi
  dashboard. Owners could not edit it per scenario, see what changed, test
  it, or learn which wording actually books more jobs.

  ## What this adds
  1. `call_scripts`            one row per (account, scenario): which version is
                               live, an optional challenger version + traffic %.
  2. `call_script_versions`    immutable, numbered history of every saved script.
  3. `call_script_assignments` which version/arm each real call received.
                               Written ONLY by the vapi-webhook (service role);
                               joined to `calls.external_id` for conversion.

  ## Security
  - Every table is tenant-scoped with `public.get_account_owner_id()` (same
    helper as calls, jobs, knowledge_articles) so team members never see
    another account's scripts.
  - Every policy ALSO requires `public.can_edit_call_scripts()` — the DB-level
    twin of the dashboard's `can_edit_business_profile` gate. A team member
    without that permission cannot read or write scripts even by calling the
    API directly. (Same pattern as `can_manage_ai_security()`.)
  - Versions are immutable: there is intentionally no UPDATE/DELETE policy.
  - Assignments have no INSERT policy for `authenticated`: the dashboard can
    never fabricate exposure data.
*/

-- =============================================================
-- 0. Permission helper (mirrors can_manage_ai_security)
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_edit_call_scripts()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        AND (
          COALESCE(tm.permissions ->> 'can_edit_business_profile', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_edit_business_profile', 'false') = 'true'
        )
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_edit_call_scripts() TO authenticated;

-- =============================================================
-- 1. call_scripts (one per account + scenario)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.call_scripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id()
    REFERENCES public.profiles(id) ON DELETE CASCADE,
  scenario text NOT NULL CHECK (scenario ~ '^[a-z][a-z_]{1,39}$'),
  active_version_id uuid,
  challenger_version_id uuid,
  challenger_traffic_pct integer NOT NULL DEFAULT 0
    CHECK (challenger_traffic_pct BETWEEN 0 AND 50),
  experiment_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, scenario)
);

-- =============================================================
-- 2. call_script_versions (immutable history)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.call_script_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id uuid NOT NULL REFERENCES public.call_scripts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  version_number integer NOT NULL,
  opening_line text NOT NULL DEFAULT '' CHECK (char_length(opening_line) <= 300),
  body text NOT NULL CHECK (char_length(body) BETWEEN 20 AND 2500),
  change_note text CHECK (change_note IS NULL OR char_length(change_note) <= 200),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (script_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_call_script_versions_script
  ON public.call_script_versions (script_id, version_number DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_scripts_active_version_fk') THEN
    ALTER TABLE public.call_scripts
      ADD CONSTRAINT call_scripts_active_version_fk
      FOREIGN KEY (active_version_id) REFERENCES public.call_script_versions(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_scripts_challenger_version_fk') THEN
    ALTER TABLE public.call_scripts
      ADD CONSTRAINT call_scripts_challenger_version_fk
      FOREIGN KEY (challenger_version_id) REFERENCES public.call_script_versions(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Version number + tenant are assigned by the database, never trusted from the client.
CREATE OR REPLACE FUNCTION public.call_script_versions_before_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner uuid;
BEGIN
  SELECT s.user_id INTO owner FROM public.call_scripts s WHERE s.id = NEW.script_id;
  IF owner IS NULL THEN
    RAISE EXCEPTION 'Script not found' USING ERRCODE = '23503';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.script_id::text, 0));
  NEW.user_id := owner;
  NEW.version_number := COALESCE(
    (SELECT MAX(v.version_number) FROM public.call_script_versions v WHERE v.script_id = NEW.script_id), 0
  ) + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_call_script_versions_before_insert ON public.call_script_versions;
CREATE TRIGGER trg_call_script_versions_before_insert
  BEFORE INSERT ON public.call_script_versions
  FOR EACH ROW EXECUTE FUNCTION public.call_script_versions_before_insert();

-- Pointer integrity + experiment lifecycle live in the database, so a buggy
-- or hand-rolled client can never put an A/B test in an impossible state.
CREATE OR REPLACE FUNCTION public.call_scripts_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.active_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.call_script_versions v
    WHERE v.id = NEW.active_version_id AND v.script_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'The live version must belong to this script' USING ERRCODE = '23514';
  END IF;

  IF NEW.challenger_version_id IS NOT NULL THEN
    IF NEW.active_version_id IS NULL THEN
      RAISE EXCEPTION 'Publish a live version before starting an A/B test' USING ERRCODE = '23514';
    END IF;
    IF NEW.challenger_version_id = NEW.active_version_id THEN
      RAISE EXCEPTION 'The challenger must be a different version than the live one' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.call_script_versions v
      WHERE v.id = NEW.challenger_version_id AND v.script_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'The challenger version must belong to this script' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT'
       OR OLD.challenger_version_id IS DISTINCT FROM NEW.challenger_version_id
       OR OLD.active_version_id IS DISTINCT FROM NEW.active_version_id THEN
      NEW.experiment_started_at := now();
    END IF;
  ELSE
    NEW.challenger_traffic_pct := 0;
    NEW.experiment_started_at := NULL;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_call_scripts_guard ON public.call_scripts;
CREATE TRIGGER trg_call_scripts_guard
  BEFORE INSERT OR UPDATE ON public.call_scripts
  FOR EACH ROW EXECUTE FUNCTION public.call_scripts_guard();

-- =============================================================
-- 3. call_script_assignments (written by vapi-webhook only)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.call_script_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  script_id uuid NOT NULL REFERENCES public.call_scripts(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES public.call_script_versions(id) ON DELETE CASCADE,
  call_external_id text NOT NULL,
  arm text NOT NULL CHECK (arm IN ('control', 'challenger')),
  after_hours boolean NOT NULL DEFAULT false,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (script_id, call_external_id)
);

CREATE INDEX IF NOT EXISTS idx_call_script_assignments_script_time
  ON public.call_script_assignments (script_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_script_assignments_user
  ON public.call_script_assignments (user_id);

-- =============================================================
-- 4. Row Level Security
-- =============================================================

ALTER TABLE public.call_scripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_script_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_script_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "call_scripts_select" ON public.call_scripts;
DROP POLICY IF EXISTS "call_scripts_insert" ON public.call_scripts;
DROP POLICY IF EXISTS "call_scripts_update" ON public.call_scripts;
DROP POLICY IF EXISTS "call_scripts_delete" ON public.call_scripts;

CREATE POLICY "call_scripts_select" ON public.call_scripts
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());
CREATE POLICY "call_scripts_insert" ON public.call_scripts
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());
CREATE POLICY "call_scripts_update" ON public.call_scripts
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());
CREATE POLICY "call_scripts_delete" ON public.call_scripts
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());

DROP POLICY IF EXISTS "call_script_versions_select" ON public.call_script_versions;
DROP POLICY IF EXISTS "call_script_versions_insert" ON public.call_script_versions;

CREATE POLICY "call_script_versions_select" ON public.call_script_versions
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());
CREATE POLICY "call_script_versions_insert" ON public.call_script_versions
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());

DROP POLICY IF EXISTS "call_script_assignments_select" ON public.call_script_assignments;

CREATE POLICY "call_script_assignments_select" ON public.call_script_assignments
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());
