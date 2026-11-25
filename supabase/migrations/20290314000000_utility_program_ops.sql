/*
  # Utility partnerships — operations layer on top of Rebate Intelligence  (item 141)

  Reuses, does not replace: incentive_programs (utility-level programs, postal_prefixes, flags),
  utility_territories (postal code -> utility), rebate_analyses + the engine (eligibility vs property/equipment),
  rebate_applications (outcome ledger). Additive only.

  New:
    utility_program_submission_profiles  how/where/by when a program is submitted + required documents
    contractor_program_enrollments       per account: enrolled as a participating contractor? (engine flag requires_participating_contractor)
    utility_partnerships                 STAFF-ONLY partnership status + agreement reference (no contacts stored here: see docs/partnerships)
    rebate_applications (+columns)       submission_method, submission_reference, submission_due_at, documents_status
    rebate_application_events            append-only status history written by trigger
  Nothing here invents a program, utility, contact, agreement or deadline: all rows are entered by staff or the account.

  Behaviour change on rebate_applications (trigger): 'paid' is final; submitted_at / decided_at / paid_at are auto-filled when
  the status moves forward and the column is empty. Existing values are never overwritten.

  Rollback: DROP TABLE rebate_application_events, utility_partnerships, contractor_program_enrollments,
  utility_program_submission_profiles CASCADE; DROP TRIGGER trg_rebate_app_before_write / trg_rebate_app_event ON rebate_applications;
  ALTER TABLE rebate_applications DROP COLUMN submission_method, submission_reference, submission_due_at, documents_status.
*/

-- 1. Submission profiles (one per program) ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.utility_program_submission_profiles (
  program_id uuid PRIMARY KEY REFERENCES public.incentive_programs (id) ON DELETE CASCADE,
  submission_method text NOT NULL DEFAULT 'unknown'
    CHECK (submission_method IN ('online_portal', 'email', 'mail', 'partner_api', 'point_of_sale', 'contractor_portal', 'unknown')),
  submission_url text CHECK (submission_url IS NULL OR (submission_url ~ '^https://' AND char_length(submission_url) <= 2048)),
  submission_deadline_days integer CHECK (submission_deadline_days IS NULL OR submission_deadline_days BETWEEN 0 AND 730),
  required_documents text[] NOT NULL DEFAULT '{}' CHECK (cardinality(required_documents) <= 20),
  source_url text CHECK (source_url IS NULL OR source_url ~ '^https://'),
  last_verified_at timestamptz,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.utility_program_submission_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "upsp_select" ON public.utility_program_submission_profiles;
CREATE POLICY "upsp_select" ON public.utility_program_submission_profiles FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.incentive_programs p
                  WHERE p.id = program_id AND (p.owner_user_id IS NULL OR p.owner_user_id = public.get_account_owner_id())));
-- Platform programs: staff write. Private programs: the owning account writes.
DROP POLICY IF EXISTS "upsp_write" ON public.utility_program_submission_profiles;
CREATE POLICY "upsp_write" ON public.utility_program_submission_profiles FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.incentive_programs p WHERE p.id = program_id
                  AND ((p.owner_user_id IS NULL AND public.is_vireek_staff(auth.uid())) OR p.owner_user_id = public.get_account_owner_id())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.incentive_programs p WHERE p.id = program_id
                  AND ((p.owner_user_id IS NULL AND public.is_vireek_staff(auth.uid())) OR p.owner_user_id = public.get_account_owner_id())));
REVOKE ALL ON public.utility_program_submission_profiles FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.utility_program_submission_profiles TO authenticated;
DROP TRIGGER IF EXISTS trg_upsp_updated_at ON public.utility_program_submission_profiles;
CREATE TRIGGER trg_upsp_updated_at BEFORE UPDATE ON public.utility_program_submission_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 2. Contractor enrolment (per account x program) --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contractor_program_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES public.incentive_programs (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'not_enrolled' CHECK (status IN ('not_enrolled', 'pending', 'active', 'suspended', 'expired')),
  enrollment_ref text CHECK (enrollment_ref IS NULL OR char_length(enrollment_ref) <= 120),
  enrolled_at date,
  expires_at date,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, program_id),
  CONSTRAINT cpe_dates CHECK (expires_at IS NULL OR enrolled_at IS NULL OR expires_at >= enrolled_at)
);
CREATE INDEX IF NOT EXISTS idx_cpe_user ON public.contractor_program_enrollments (user_id, status);
ALTER TABLE public.contractor_program_enrollments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cpe_select_own" ON public.contractor_program_enrollments;
CREATE POLICY "cpe_select_own" ON public.contractor_program_enrollments FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "cpe_insert_own" ON public.contractor_program_enrollments;
CREATE POLICY "cpe_insert_own" ON public.contractor_program_enrollments FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id()
              AND EXISTS (SELECT 1 FROM public.incentive_programs p WHERE p.id = program_id AND (p.owner_user_id IS NULL OR p.owner_user_id = user_id)));
DROP POLICY IF EXISTS "cpe_update_own" ON public.contractor_program_enrollments;
CREATE POLICY "cpe_update_own" ON public.contractor_program_enrollments FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "cpe_delete_own" ON public.contractor_program_enrollments;
CREATE POLICY "cpe_delete_own" ON public.contractor_program_enrollments FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());
REVOKE ALL ON public.contractor_program_enrollments FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contractor_program_enrollments TO authenticated;
DROP TRIGGER IF EXISTS trg_cpe_updated_at ON public.contractor_program_enrollments;
CREATE TRIGGER trg_cpe_updated_at BEFORE UPDATE ON public.contractor_program_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 3. Partnerships (STAFF ONLY; status + agreement reference; no personal contacts) ------------------
CREATE TABLE IF NOT EXISTS public.utility_partnerships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_name text NOT NULL CHECK (char_length(btrim(utility_name)) BETWEEN 2 AND 120),
  state text CHECK (state IS NULL OR state ~ '^[A-Z]{2}$'),
  program_id uuid REFERENCES public.incentive_programs (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'prospect' CHECK (status IN ('prospect', 'in_discussion', 'agreement_signed', 'live', 'paused', 'ended')),
  agreement_ref text CHECK (agreement_ref IS NULL OR char_length(agreement_ref) <= 200),
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- a partnership cannot be marked signed/live without an agreement reference
  CONSTRAINT up_signed_has_ref CHECK (status NOT IN ('agreement_signed', 'live') OR agreement_ref IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_utility_partnerships ON public.utility_partnerships (lower(utility_name), COALESCE(state, ''));
ALTER TABLE public.utility_partnerships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "up_staff_all" ON public.utility_partnerships;
CREATE POLICY "up_staff_all" ON public.utility_partnerships FOR ALL TO authenticated
  USING (public.is_vireek_staff(auth.uid())) WITH CHECK (public.is_vireek_staff(auth.uid()));
REVOKE ALL ON public.utility_partnerships FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.utility_partnerships TO authenticated;
DROP TRIGGER IF EXISTS trg_up_updated_at ON public.utility_partnerships;
CREATE TRIGGER trg_up_updated_at BEFORE UPDATE ON public.utility_partnerships
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 4. Submission tracking on the existing ledger ------------------------------------------------------
ALTER TABLE public.rebate_applications
  ADD COLUMN IF NOT EXISTS submission_method text,
  ADD COLUMN IF NOT EXISTS submission_reference text,
  ADD COLUMN IF NOT EXISTS submission_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS documents_status jsonb NOT NULL DEFAULT '{}'::jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rebate_app_submission_method_chk') THEN
    ALTER TABLE public.rebate_applications ADD CONSTRAINT rebate_app_submission_method_chk
      CHECK (submission_method IS NULL OR submission_method IN ('online_portal', 'email', 'mail', 'partner_api', 'point_of_sale', 'contractor_portal', 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rebate_app_submission_ref_chk') THEN
    ALTER TABLE public.rebate_applications ADD CONSTRAINT rebate_app_submission_ref_chk
      CHECK (submission_reference IS NULL OR char_length(submission_reference) <= 120);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rebate_app_documents_status_chk') THEN
    ALTER TABLE public.rebate_applications ADD CONSTRAINT rebate_app_documents_status_chk
      CHECK (jsonb_typeof(documents_status) = 'object');
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_rebate_app_due ON public.rebate_applications (user_id, submission_due_at)
  WHERE status IN ('identified', 'proposed') AND submission_due_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.rebate_application_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  application_id uuid NOT NULL REFERENCES public.rebate_applications (id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  approved_cents integer,
  paid_cents integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rae_app ON public.rebate_application_events (application_id, created_at);
ALTER TABLE public.rebate_application_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rae_select_own" ON public.rebate_application_events;
CREATE POLICY "rae_select_own" ON public.rebate_application_events FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
REVOKE ALL ON public.rebate_application_events FROM anon, authenticated;
GRANT SELECT ON public.rebate_application_events TO authenticated;
DROP TRIGGER IF EXISTS trg_rae_no_update ON public.rebate_application_events;
CREATE TRIGGER trg_rae_no_update BEFORE UPDATE ON public.rebate_application_events
  FOR EACH ROW EXECUTE FUNCTION public.rr_forbid_change();

CREATE OR REPLACE FUNCTION public.rebate_app_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'paid' AND NEW.status <> 'paid' THEN
    RAISE EXCEPTION 'A paid rebate is final' USING ERRCODE = '55000';
  END IF;
  IF NEW.status IN ('submitted', 'approved', 'paid') THEN NEW.submitted_at := COALESCE(NEW.submitted_at, now()); END IF;
  IF NEW.status IN ('approved', 'denied', 'paid') THEN NEW.decided_at := COALESCE(NEW.decided_at, now()); END IF;
  IF NEW.status = 'paid' THEN NEW.paid_at := COALESCE(NEW.paid_at, now()); END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_rebate_app_before_write ON public.rebate_applications;
CREATE TRIGGER trg_rebate_app_before_write BEFORE INSERT OR UPDATE ON public.rebate_applications
  FOR EACH ROW EXECUTE FUNCTION public.rebate_app_before_write();

CREATE OR REPLACE FUNCTION public.rebate_app_record_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.rebate_application_events (user_id, application_id, from_status, to_status, approved_cents, paid_cents)
    VALUES (NEW.user_id, NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, NEW.approved_cents, NEW.paid_cents);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.rebate_app_record_event() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_rebate_app_event ON public.rebate_applications;
CREATE TRIGGER trg_rebate_app_event AFTER INSERT OR UPDATE ON public.rebate_applications
  FOR EACH ROW EXECUTE FUNCTION public.rebate_app_record_event();

-- 5. Deadline helper: due = completion + the program's submission_deadline_days (NULL when the program has none) ----
CREATE OR REPLACE FUNCTION public.rebate_set_submission_due(p_application uuid, p_completed_at timestamptz)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_days integer; v_due timestamptz;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR p_completed_at IS NULL THEN RETURN NULL; END IF;
  SELECT sp.submission_deadline_days INTO v_days
    FROM public.rebate_applications a
    JOIN public.utility_program_submission_profiles sp ON sp.program_id = a.program_id
   WHERE a.id = p_application AND a.user_id = v_owner;
  IF v_days IS NULL THEN RETURN NULL; END IF;
  v_due := p_completed_at + make_interval(days => v_days);
  UPDATE public.rebate_applications SET submission_due_at = v_due WHERE id = p_application AND user_id = v_owner;
  RETURN v_due;
END;
$$;
REVOKE ALL ON FUNCTION public.rebate_set_submission_due(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rebate_set_submission_due(uuid, timestamptz) TO authenticated;
