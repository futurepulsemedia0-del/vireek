/*
  # Refrigerant & regulated-materials compliance log

  ## Why
  HVAC/refrigeration work that adds or recovers refrigerant is regulated
  (US: EPA Clean Air Act §608 / 40 CFR Part 82 Subpart F, and 40 CFR Part 84
  for HFCs). Shops must be able to show, per appliance: what was added or
  recovered, how much, by whom, and that the technician held a valid EPA 608
  certification at the time. Records are kept for 3 years.

  ## What this adds (reuses the existing compliance system)
  - Reuses `technician_credentials` (the Compliance Center credential store)
    as the certification source. Recognised credential_type codes:
    epa_608 (legacy / type not recorded), epa_608_type_i, epa_608_type_ii,
    epa_608_type_iii, epa_608_universal.
  - Reuses `equipment` (adds refrigerant type, full charge, appliance category).
  - Reuses `log_audit_event()` for the audit trail.
  - `refrigerant_log`: append-only ledger. One row per add / recover event,
    per unit. A BEFORE INSERT guard (server-side, cannot be bypassed from the
    client) verifies tenant ownership, the technician's certification on the
    date of work, and snapshots certification + equipment details onto the row
    so the record stays complete even if the job / equipment / credential is
    later deleted or renewed.
  - Rows can never be edited or deleted by clients. Mistakes are voided via
    `void_refrigerant_entry()` (owner only, reason required, audited); the
    original row stays in the ledger.

  ## RLS
  Same tenant pattern as the rest of the project (get_account_owner_id()).
  No UPDATE / DELETE policies on purpose.
*/

-- =============================================================
-- EQUIPMENT: refrigerant profile
-- =============================================================

ALTER TABLE equipment
  ADD COLUMN IF NOT EXISTS refrigerant_type text,
  ADD COLUMN IF NOT EXISTS refrigerant_charge_lbs numeric(8,2),
  ADD COLUMN IF NOT EXISTS appliance_category text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'equipment_refrigerant_charge_positive') THEN
    ALTER TABLE equipment
      ADD CONSTRAINT equipment_refrigerant_charge_positive
      CHECK (refrigerant_charge_lbs IS NULL OR refrigerant_charge_lbs > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'equipment_appliance_category_valid') THEN
    ALTER TABLE equipment
      ADD CONSTRAINT equipment_appliance_category_valid
      CHECK (appliance_category IS NULL OR appliance_category IN
        ('comfort_cooling', 'commercial_refrigeration', 'industrial_process', 'other'));
  END IF;
END $$;

-- =============================================================
-- REFRIGERANT_LOG (append-only ledger)
-- =============================================================

CREATE TABLE IF NOT EXISTS refrigerant_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN ('added', 'recovered')),
  refrigerant_type text NOT NULL CHECK (char_length(btrim(refrigerant_type)) BETWEEN 1 AND 40),
  pounds numeric(8,2) NOT NULL CHECK (pounds > 0),
  performed_at timestamptz NOT NULL DEFAULT now(),
  cylinder_ref text CHECK (cylinder_ref IS NULL OR char_length(cylinder_ref) <= 80),
  disposition text CHECK (disposition IS NULL OR disposition IN
    ('returned_to_cylinder', 'sent_to_reclaimer', 'recycled_on_site', 'destroyed', 'other')),
  leak_found boolean NOT NULL DEFAULT false,
  leak_repaired boolean,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  -- Snapshots (filled by the guard trigger; survive deletion of the source rows)
  equipment_label text,
  equipment_serial text,
  site_address text,
  technician_name text,
  cert_credential_id uuid REFERENCES technician_credentials(id) ON DELETE SET NULL,
  cert_type text NOT NULL,
  cert_number text,
  -- Voiding (the only permitted mutation)
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refrigerant_log_disposition_matches_event CHECK (
    (event_type = 'recovered' AND disposition IS NOT NULL)
    OR (event_type = 'added' AND disposition IS NULL)
  ),
  CONSTRAINT refrigerant_log_void_consistent CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND char_length(btrim(coalesce(void_reason, ''))) >= 5)
  )
);

CREATE INDEX IF NOT EXISTS idx_refrigerant_log_user_performed ON refrigerant_log(user_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_refrigerant_log_equipment ON refrigerant_log(equipment_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_refrigerant_log_job ON refrigerant_log(job_id);

ALTER TABLE refrigerant_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_refrigerant_log" ON refrigerant_log;
CREATE POLICY "select_own_refrigerant_log" ON refrigerant_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_refrigerant_log" ON refrigerant_log;
CREATE POLICY "insert_own_refrigerant_log" ON refrigerant_log FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
-- Intentionally NO update / delete policies: the ledger is append-only.

-- =============================================================
-- GUARD: BEFORE INSERT
-- =============================================================

CREATE OR REPLACE FUNCTION public.refrigerant_log_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_job record;
  v_eq record;
  v_tech record;
  v_cred record;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'refrigerant_log: not authenticated' USING ERRCODE = '42501';
  END IF;
  NEW.user_id := v_owner;

  IF NEW.job_id IS NULL OR NEW.equipment_id IS NULL OR NEW.technician_id IS NULL THEN
    RAISE EXCEPTION 'refrigerant_log: job, unit and technician are required' USING ERRCODE = '23502';
  END IF;

  IF NEW.performed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'refrigerant_log: performed_at cannot be in the future' USING ERRCODE = '22007';
  END IF;

  SELECT j.id, j.address INTO v_job FROM jobs j WHERE j.id = NEW.job_id AND j.user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refrigerant_log: job not found' USING ERRCODE = '42501';
  END IF;

  SELECT e.id, e.equipment_type, e.make, e.model, e.serial_number, e.refrigerant_charge_lbs
    INTO v_eq FROM equipment e WHERE e.id = NEW.equipment_id AND e.user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refrigerant_log: unit not found' USING ERRCODE = '42501';
  END IF;

  SELECT tm.id, tm.member_name INTO v_tech
  FROM team_members tm WHERE tm.id = NEW.technician_id AND tm.account_owner_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refrigerant_log: technician not found' USING ERRCODE = '42501';
  END IF;

  -- Certification gate (mirrors technician_compliance_gaps(): active and
  -- not expired on the date of work). Type I only covers small appliances
  -- (<= 5 lb); when the charge is unknown it is accepted.
  SELECT tc.id, tc.credential_type, tc.credential_number INTO v_cred
  FROM technician_credentials tc
  WHERE tc.technician_id = NEW.technician_id
    AND tc.credential_type IN ('epa_608', 'epa_608_type_i', 'epa_608_type_ii', 'epa_608_type_iii', 'epa_608_universal')
    AND tc.status = 'active'
    AND (tc.expires_at IS NULL OR tc.expires_at >= (NEW.performed_at AT TIME ZONE 'UTC')::date)
    AND (tc.credential_type <> 'epa_608_type_i' OR v_eq.refrigerant_charge_lbs IS NULL OR v_eq.refrigerant_charge_lbs <= 5)
  ORDER BY CASE tc.credential_type
    WHEN 'epa_608_universal' THEN 0 WHEN 'epa_608_type_ii' THEN 1 WHEN 'epa_608_type_iii' THEN 1
    WHEN 'epa_608' THEN 2 ELSE 3 END, tc.expires_at DESC NULLS FIRST
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'refrigerant_cert_required: % has no valid EPA 608 certification on file for this work',
      COALESCE(v_tech.member_name, 'technician') USING ERRCODE = '42501';
  END IF;

  IF NEW.event_type = 'recovered' AND NEW.disposition IS NULL THEN
    RAISE EXCEPTION 'refrigerant_log: recovered refrigerant needs a disposition' USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type = 'added' THEN
    NEW.disposition := NULL;
  END IF;

  NEW.refrigerant_type := btrim(NEW.refrigerant_type);
  NEW.cert_credential_id := v_cred.id;
  NEW.cert_type := v_cred.credential_type;
  NEW.cert_number := v_cred.credential_number;
  NEW.technician_name := v_tech.member_name;
  NEW.site_address := v_job.address;
  NEW.equipment_serial := v_eq.serial_number;
  NEW.equipment_label := NULLIF(btrim(concat_ws(' ', v_eq.make, v_eq.model, v_eq.equipment_type)), '');
  NEW.voided_at := NULL;
  NEW.voided_by := NULL;
  NEW.void_reason := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_refrigerant_log_before_insert ON refrigerant_log;
CREATE TRIGGER trg_refrigerant_log_before_insert
  BEFORE INSERT ON refrigerant_log
  FOR EACH ROW EXECUTE FUNCTION public.refrigerant_log_before_insert();

-- =============================================================
-- GUARD: BEFORE UPDATE (append-only; allow void + FK detach on delete)
-- =============================================================

CREATE OR REPLACE FUNCTION public.refrigerant_log_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.id, NEW.user_id, NEW.event_type, NEW.refrigerant_type, NEW.pounds, NEW.performed_at,
      NEW.cylinder_ref, NEW.disposition, NEW.leak_found, NEW.leak_repaired, NEW.notes,
      NEW.equipment_label, NEW.equipment_serial, NEW.site_address, NEW.technician_name,
      NEW.cert_type, NEW.cert_number, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.user_id, OLD.event_type, OLD.refrigerant_type, OLD.pounds, OLD.performed_at,
      OLD.cylinder_ref, OLD.disposition, OLD.leak_found, OLD.leak_repaired, OLD.notes,
      OLD.equipment_label, OLD.equipment_serial, OLD.site_address, OLD.technician_name,
      OLD.cert_type, OLD.cert_number, OLD.created_at)
  THEN
    RAISE EXCEPTION 'refrigerant_log entries are immutable; void the entry instead' USING ERRCODE = '42501';
  END IF;

  -- FK columns may only be detached (ON DELETE SET NULL), never re-pointed.
  IF (NEW.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id)
     OR (NEW.equipment_id IS NOT NULL AND NEW.equipment_id IS DISTINCT FROM OLD.equipment_id)
     OR (NEW.technician_id IS NOT NULL AND NEW.technician_id IS DISTINCT FROM OLD.technician_id)
     OR (NEW.cert_credential_id IS NOT NULL AND NEW.cert_credential_id IS DISTINCT FROM OLD.cert_credential_id)
  THEN
    RAISE EXCEPTION 'refrigerant_log links cannot be changed' USING ERRCODE = '42501';
  END IF;

  IF OLD.voided_at IS NOT NULL
     AND (NEW.voided_at, NEW.voided_by, NEW.void_reason) IS DISTINCT FROM (OLD.voided_at, OLD.voided_by, OLD.void_reason)
  THEN
    RAISE EXCEPTION 'refrigerant_log entry is already voided' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_refrigerant_log_before_update ON refrigerant_log;
CREATE TRIGGER trg_refrigerant_log_before_update
  BEFORE UPDATE ON refrigerant_log
  FOR EACH ROW EXECUTE FUNCTION public.refrigerant_log_before_update();

-- =============================================================
-- AUDIT: AFTER INSERT
-- =============================================================

CREATE OR REPLACE FUNCTION public.refrigerant_log_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.log_audit_event(NEW.user_id, 'refrigerant_log.' || NEW.event_type, 'refrigerant_log', NEW.id::text);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_refrigerant_log_after_insert ON refrigerant_log;
CREATE TRIGGER trg_refrigerant_log_after_insert
  AFTER INSERT ON refrigerant_log
  FOR EACH ROW EXECUTE FUNCTION public.refrigerant_log_after_insert();

-- =============================================================
-- VOID RPC (owner only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.void_refrigerant_entry(p_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF v_owner IS NULL OR NOT public.is_account_owner() THEN
    RAISE EXCEPTION 'Only the account owner can void refrigerant entries' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < 5 THEN
    RAISE EXCEPTION 'A reason of at least 5 characters is required' USING ERRCODE = '22023';
  END IF;

  UPDATE refrigerant_log
  SET voided_at = now(), voided_by = auth.uid(), void_reason = v_reason
  WHERE id = p_id AND user_id = v_owner AND voided_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entry not found or already voided' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public.log_audit_event(v_owner, 'refrigerant_log.voided', 'refrigerant_log', p_id::text);
END;
$$;

REVOKE ALL ON FUNCTION public.void_refrigerant_entry(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.void_refrigerant_entry(uuid, text) TO authenticated;
