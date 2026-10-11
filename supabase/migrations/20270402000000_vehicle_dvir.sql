/*
  # Vehicle DVIR — pre-trip / post-trip inspections

  Reuses `vehicles` and `vehicle_faults` (no new fault table). Adds:
  - dvir_checklist_items   configurable checklist per account (seeded with defaults on first use)
  - vehicle_inspections    immutable inspection records (odometer, signature, per-item results snapshot)
  - vehicle_faults         + inspection_id, blocks_dispatch, photo_paths, reporter, resolution fields
  - private storage bucket `dvir-media` (defect photos + signatures)
  - submit_vehicle_inspection()  validates server-side, writes faults, notifies owner when unsafe
  - resolve_vehicle_defect()     staff-only; clears a DVIR fault with an audit note
  - dvir_blocked_technicians()   technicians whose every vehicle is out of service
  - trigger on jobs              blocks assigning to / starting jobs for a blocked technician
  - patches assign_technician_to_job() (if the expected lines exist) to skip / refuse blocked technicians

  Additive and idempotent. The jobs trigger is the guarantee; the function patch is best-effort UX.
*/

-- =============================================================
-- 0. HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.dvir_caller_is_staff()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
      OR EXISTS (SELECT 1 FROM team_members WHERE user_id = auth.uid() AND role <> 'technician');
$$;

-- =============================================================
-- 1. CHECKLIST
-- =============================================================

CREATE TABLE IF NOT EXISTS public.dvir_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  item_key text NOT NULL CHECK (item_key ~ '^[a-z0-9_]{1,32}$'),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
  category text NOT NULL DEFAULT 'general' CHECK (char_length(category) BETWEEN 1 AND 40),
  severity_if_defect text NOT NULL DEFAULT 'major' CHECK (severity_if_defect IN ('minor', 'major', 'out_of_service')),
  applies_to text NOT NULL DEFAULT 'both' CHECK (applies_to IN ('pre_trip', 'post_trip', 'both')),
  requires_photo boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, item_key)
);

ALTER TABLE public.dvir_checklist_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dvir_items_select" ON public.dvir_checklist_items;
CREATE POLICY "dvir_items_select" ON public.dvir_checklist_items FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "dvir_items_insert" ON public.dvir_checklist_items;
CREATE POLICY "dvir_items_insert" ON public.dvir_checklist_items FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.dvir_caller_is_staff());

DROP POLICY IF EXISTS "dvir_items_update" ON public.dvir_checklist_items;
CREATE POLICY "dvir_items_update" ON public.dvir_checklist_items FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.dvir_caller_is_staff())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.dvir_caller_is_staff());

DROP POLICY IF EXISTS "dvir_items_delete" ON public.dvir_checklist_items;
CREATE POLICY "dvir_items_delete" ON public.dvir_checklist_items FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.dvir_caller_is_staff());

CREATE OR REPLACE FUNCTION public.dvir_seed_default_checklist(p_owner uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM dvir_checklist_items WHERE user_id = p_owner) THEN RETURN; END IF;
  INSERT INTO dvir_checklist_items (user_id, item_key, label, category, severity_if_defect, applies_to, requires_photo, sort_order)
  VALUES
    (p_owner, 'service_brakes',   'Service brakes',                      'Safety',     'out_of_service', 'both',     true,  10),
    (p_owner, 'parking_brake',    'Parking brake',                       'Safety',     'major',          'both',     false, 20),
    (p_owner, 'steering',         'Steering mechanism',                  'Safety',     'out_of_service', 'both',     true,  30),
    (p_owner, 'tires_wheels',     'Tires, wheels and lug nuts',          'Safety',     'out_of_service', 'both',     true,  40),
    (p_owner, 'seat_belts',       'Seat belts',                          'Safety',     'out_of_service', 'pre_trip', false, 50),
    (p_owner, 'hitch_coupling',   'Hitch, coupling and safety chains',   'Safety',     'out_of_service', 'both',     true,  60),
    (p_owner, 'lights',           'Headlights, brake and turn lights',   'Visibility', 'major',          'both',     false, 70),
    (p_owner, 'mirrors',          'Mirrors',                             'Visibility', 'major',          'pre_trip', false, 80),
    (p_owner, 'windshield',       'Windshield and wipers',               'Visibility', 'major',          'pre_trip', false, 90),
    (p_owner, 'horn',             'Horn',                                'Visibility', 'minor',          'pre_trip', false, 100),
    (p_owner, 'warning_lights',   'Dashboard warning lights',            'Engine',     'major',          'both',     false, 110),
    (p_owner, 'fluid_leaks',      'Fluid leaks under vehicle',           'Engine',     'major',          'both',     true,  120),
    (p_owner, 'exhaust',          'Exhaust system',                      'Engine',     'major',          'both',     false, 130),
    (p_owner, 'cargo_secured',    'Ladders, tools and cargo secured',    'Cargo',      'major',          'both',     false, 140),
    (p_owner, 'fire_extinguisher','Fire extinguisher charged',           'Equipment',  'major',          'pre_trip', false, 150),
    (p_owner, 'first_aid',        'First-aid kit stocked',               'Equipment',  'minor',          'pre_trip', false, 160),
    (p_owner, 'body_damage',      'New body damage',                     'Body',       'minor',          'both',     true,  170)
  ON CONFLICT (user_id, item_key) DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.dvir_seed_default_checklist(uuid) FROM PUBLIC, anon, authenticated;

-- Returns the active checklist for an inspection type (seeds defaults on first use).
CREATE OR REPLACE FUNCTION public.dvir_get_checklist(p_inspection_type text)
RETURNS SETOF public.dvir_checklist_items
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF p_inspection_type NOT IN ('pre_trip', 'post_trip') THEN RAISE EXCEPTION 'Invalid inspection type'; END IF;
  PERFORM public.dvir_seed_default_checklist(v_owner);
  RETURN QUERY
    SELECT * FROM dvir_checklist_items
    WHERE user_id = v_owner AND active AND (applies_to = 'both' OR applies_to = p_inspection_type)
    ORDER BY sort_order, label;
END;
$$;
REVOKE ALL ON FUNCTION public.dvir_get_checklist(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dvir_get_checklist(text) TO authenticated;

-- =============================================================
-- 2. INSPECTIONS (immutable: no UPDATE / DELETE policies, no INSERT policy — RPC only)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.vehicle_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  submitted_by uuid NOT NULL DEFAULT auth.uid(),
  inspection_type text NOT NULL CHECK (inspection_type IN ('pre_trip', 'post_trip')),
  odometer_miles numeric NOT NULL CHECK (odometer_miles >= 0 AND odometer_miles < 5000000),
  odometer_anomaly boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('satisfactory', 'defects_noted', 'unsafe')),
  declared_unsafe boolean NOT NULL DEFAULT false,
  defect_count integer NOT NULL DEFAULT 0 CHECK (defect_count >= 0),
  results jsonb NOT NULL CHECK (jsonb_typeof(results) = 'array'),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  signed_name text NOT NULL CHECK (char_length(btrim(signed_name)) BETWEEN 2 AND 120),
  signature_path text NOT NULL,
  latitude double precision,
  longitude double precision,
  client_submission_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_submission_id)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_inspections_vehicle ON public.vehicle_inspections(vehicle_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_inspections_user ON public.vehicle_inspections(user_id, created_at DESC);

ALTER TABLE public.vehicle_inspections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dvir_inspections_select" ON public.vehicle_inspections;
CREATE POLICY "dvir_inspections_select" ON public.vehicle_inspections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 3. vehicle_faults — additive columns
-- =============================================================

ALTER TABLE public.vehicle_faults
  ADD COLUMN IF NOT EXISTS inspection_id uuid REFERENCES public.vehicle_inspections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS blocks_dispatch boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS photo_paths text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS reported_by_team_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolution_note text,
  ADD COLUMN IF NOT EXISTS resolved_by uuid;

CREATE INDEX IF NOT EXISTS idx_vehicle_faults_blocking
  ON public.vehicle_faults(vehicle_id) WHERE blocks_dispatch AND cleared_at IS NULL;

-- =============================================================
-- 4. STORAGE (private; first path segment = account owner id)
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('dvir-media', 'dvir-media', false, 15728640, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "dvir_media_select" ON storage.objects;
CREATE POLICY "dvir_media_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'dvir-media' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);

DROP POLICY IF EXISTS "dvir_media_insert" ON storage.objects;
CREATE POLICY "dvir_media_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'dvir-media' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);
-- No UPDATE / DELETE: inspection evidence is write-once for clients.

-- =============================================================
-- 5. BLOCK LOGIC
-- =============================================================

-- True when the technician has at least one non-retired vehicle and ALL of them have an open blocking defect.
CREATE OR REPLACE FUNCTION public.dvir_technician_blocked(p_technician_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(bool_or(s.blocked), false) AND NOT COALESCE(bool_or(NOT s.blocked), false)
  FROM (
    SELECT EXISTS (
      SELECT 1 FROM vehicle_faults f
      WHERE f.vehicle_id = v.id AND f.cleared_at IS NULL AND f.blocks_dispatch
    ) AS blocked
    FROM vehicles v
    WHERE v.assigned_technician_id = p_technician_id AND v.status <> 'retired'
  ) s;
$$;
REVOKE ALL ON FUNCTION public.dvir_technician_blocked(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dvir_technician_blocked(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.dvir_blocked_technicians()
RETURNS TABLE (technician_id uuid, vehicle_id uuid, vehicle_label text, defect_count integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT v.assigned_technician_id, v.id, v.label,
         (SELECT count(*)::integer FROM vehicle_faults f
           WHERE f.vehicle_id = v.id AND f.cleared_at IS NULL AND f.blocks_dispatch)
  FROM vehicles v
  WHERE v.user_id = public.get_account_owner_id()
    AND v.assigned_technician_id IS NOT NULL
    AND v.status <> 'retired'
    AND public.dvir_technician_blocked(v.assigned_technician_id)
    AND EXISTS (SELECT 1 FROM vehicle_faults f WHERE f.vehicle_id = v.id AND f.cleared_at IS NULL AND f.blocks_dispatch);
$$;
REVOKE ALL ON FUNCTION public.dvir_blocked_technicians() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dvir_blocked_technicians() TO authenticated;

-- Hard guarantee: whatever code path assigns or starts a job, a blocked technician cannot be dispatched.
CREATE OR REPLACE FUNCTION public.dvir_enforce_dispatch_gate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_label text;
BEGIN
  IF NEW.assigned_technician_id IS NULL THEN RETURN NEW; END IF;
  IF NOT (
    NEW.assigned_technician_id IS DISTINCT FROM OLD.assigned_technician_id
    OR (NEW.job_status IS DISTINCT FROM OLD.job_status AND NEW.job_status IN ('en_route', 'in_progress'))
  ) THEN
    RETURN NEW;
  END IF;
  IF public.dvir_technician_blocked(NEW.assigned_technician_id) THEN
    SELECT v.label INTO v_label FROM vehicles v
    WHERE v.assigned_technician_id = NEW.assigned_technician_id AND v.status <> 'retired'
    ORDER BY v.created_at LIMIT 1;
    RAISE EXCEPTION 'DVIR_BLOCKED: vehicle "%" is out of service (open safety defect). Resolve it in Fleet DVIR before dispatching.', COALESCE(v_label, 'unknown')
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dvir_dispatch_gate ON public.jobs;
CREATE TRIGGER trg_dvir_dispatch_gate
  BEFORE UPDATE OF assigned_technician_id, job_status ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.dvir_enforce_dispatch_gate();

-- =============================================================
-- 6. SUBMIT INSPECTION
-- =============================================================

CREATE OR REPLACE FUNCTION public.submit_vehicle_inspection(
  p_vehicle_id uuid,
  p_inspection_type text,
  p_odometer_miles numeric,
  p_results jsonb,
  p_notes text,
  p_declared_unsafe boolean,
  p_signed_name text,
  p_signature_path text,
  p_client_submission_id uuid,
  p_latitude double precision DEFAULT NULL,
  p_longitude double precision DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tm uuid := public.get_my_team_member_id();
  v_prefix text;
  v_vehicle record;
  v_existing record;
  v_item record;
  v_entry jsonb;
  v_result text;
  v_note text;
  v_photos text[];
  v_norm jsonb := '[]'::jsonb;
  v_defects integer := 0;
  v_blocking boolean := false;
  v_status text;
  v_anomaly boolean;
  v_id uuid;
  v_sev text;
  v_p text;
  v_jobs integer := 0;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Not authorized'; END IF;
  v_prefix := v_owner::text || '/';

  SELECT id, status INTO v_existing FROM vehicle_inspections
  WHERE user_id = v_owner AND client_submission_id = p_client_submission_id;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'ok', 'duplicate', true, 'inspection_id', v_existing.id, 'result_status', v_existing.status);
  END IF;

  IF p_inspection_type NOT IN ('pre_trip', 'post_trip') THEN RAISE EXCEPTION 'Invalid inspection type'; END IF;
  IF p_odometer_miles IS NULL OR p_odometer_miles < 0 OR p_odometer_miles >= 5000000 THEN RAISE EXCEPTION 'Enter a valid odometer reading'; END IF;
  IF p_results IS NULL OR jsonb_typeof(p_results) <> 'array' OR jsonb_array_length(p_results) > 120 THEN RAISE EXCEPTION 'Invalid results'; END IF;
  IF char_length(btrim(COALESCE(p_signed_name, ''))) < 2 THEN RAISE EXCEPTION 'Signature name is required'; END IF;
  IF p_signature_path IS NULL OR left(p_signature_path, length(v_prefix)) <> v_prefix OR position('..' IN p_signature_path) > 0 THEN
    RAISE EXCEPTION 'A signature is required';
  END IF;
  IF COALESCE(p_declared_unsafe, false) AND char_length(btrim(COALESCE(p_notes, ''))) < 3 THEN
    RAISE EXCEPTION 'Describe why the vehicle is unsafe';
  END IF;

  SELECT id, label, status, odometer_miles, assigned_technician_id INTO v_vehicle
  FROM vehicles WHERE id = p_vehicle_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle not found'; END IF;
  IF v_vehicle.status = 'retired' THEN RAISE EXCEPTION 'Vehicle is retired'; END IF;

  PERFORM public.dvir_seed_default_checklist(v_owner);

  FOR v_item IN
    SELECT * FROM dvir_checklist_items
    WHERE user_id = v_owner AND active AND (applies_to = 'both' OR applies_to = p_inspection_type)
    ORDER BY sort_order, label
  LOOP
    SELECT e INTO v_entry FROM jsonb_array_elements(p_results) e WHERE e->>'key' = v_item.item_key LIMIT 1;
    IF v_entry IS NULL THEN RAISE EXCEPTION 'Checklist item "%" was not answered', v_item.label; END IF;
    v_result := v_entry->>'result';
    IF v_result NOT IN ('pass', 'defect', 'na') THEN RAISE EXCEPTION 'Invalid answer for "%"', v_item.label; END IF;
    v_note := NULLIF(btrim(COALESCE(v_entry->>'note', '')), '');
    v_photos := '{}';

    IF v_result = 'defect' THEN
      IF v_note IS NULL OR char_length(v_note) < 3 THEN RAISE EXCEPTION 'Describe the defect for "%"', v_item.label; END IF;
      IF jsonb_typeof(v_entry->'photos') = 'array' THEN
        SELECT COALESCE(array_agg(p), '{}') INTO v_photos FROM jsonb_array_elements_text(v_entry->'photos') p;
      END IF;
      IF cardinality(v_photos) > 6 THEN RAISE EXCEPTION 'Too many photos for "%"', v_item.label; END IF;
      FOREACH v_p IN ARRAY v_photos LOOP
        IF left(v_p, length(v_prefix)) <> v_prefix OR position('..' IN v_p) > 0 THEN RAISE EXCEPTION 'Invalid photo path'; END IF;
      END LOOP;
      IF (v_item.severity_if_defect = 'out_of_service' OR v_item.requires_photo) AND cardinality(v_photos) = 0 THEN
        RAISE EXCEPTION 'A photo is required for "%"', v_item.label;
      END IF;
      v_defects := v_defects + 1;
      IF v_item.severity_if_defect = 'out_of_service' THEN v_blocking := true; END IF;
    END IF;

    v_norm := v_norm || jsonb_build_object(
      'key', v_item.item_key, 'label', v_item.label, 'category', v_item.category,
      'severity', v_item.severity_if_defect, 'result', v_result,
      'note', CASE WHEN v_result = 'defect' THEN v_note END,
      'photos', to_jsonb(v_photos)
    );
  END LOOP;

  v_blocking := v_blocking OR COALESCE(p_declared_unsafe, false);
  v_status := CASE WHEN v_blocking THEN 'unsafe' WHEN v_defects > 0 THEN 'defects_noted' ELSE 'satisfactory' END;
  v_anomaly := p_odometer_miles < COALESCE(v_vehicle.odometer_miles, 0);

  INSERT INTO vehicle_inspections (
    user_id, vehicle_id, technician_id, inspection_type, odometer_miles, odometer_anomaly, status, declared_unsafe,
    defect_count, results, notes, signed_name, signature_path, latitude, longitude, client_submission_id
  ) VALUES (
    v_owner, p_vehicle_id, v_tm, p_inspection_type, p_odometer_miles, v_anomaly, v_status, COALESCE(p_declared_unsafe, false),
    v_defects, v_norm, NULLIF(btrim(COALESCE(p_notes, '')), ''), btrim(p_signed_name), p_signature_path,
    p_latitude, p_longitude, p_client_submission_id
  ) RETURNING id INTO v_id;

  FOR v_entry IN SELECT e FROM jsonb_array_elements(v_norm) e WHERE e->>'result' = 'defect' LOOP
    v_sev := CASE v_entry->>'severity' WHEN 'out_of_service' THEN 'critical' WHEN 'major' THEN 'high' ELSE 'low' END;
    SELECT COALESCE(array_agg(p), '{}') INTO v_photos FROM jsonb_array_elements_text(v_entry->'photos') p;
    INSERT INTO vehicle_faults (
      user_id, vehicle_id, code, description, severity, check_engine, source,
      inspection_id, blocks_dispatch, photo_paths, reported_by_team_member_id
    ) VALUES (
      v_owner, p_vehicle_id, 'DVIR:' || upper(v_entry->>'key'),
      left((v_entry->>'label') || ': ' || (v_entry->>'note'), 300), v_sev, false, 'dvir',
      v_id, (v_entry->>'severity') = 'out_of_service', v_photos, v_tm
    )
    ON CONFLICT (vehicle_id, code) WHERE cleared_at IS NULL DO UPDATE SET
      last_seen_at = now(),
      description = EXCLUDED.description,
      severity = CASE
        WHEN array_position(ARRAY['low', 'medium', 'high', 'critical'], EXCLUDED.severity)
           > array_position(ARRAY['low', 'medium', 'high', 'critical'], vehicle_faults.severity)
        THEN EXCLUDED.severity ELSE vehicle_faults.severity END,
      blocks_dispatch = vehicle_faults.blocks_dispatch OR EXCLUDED.blocks_dispatch,
      photo_paths = (vehicle_faults.photo_paths || EXCLUDED.photo_paths)[1:12];
  END LOOP;

  IF COALESCE(p_declared_unsafe, false) THEN
    INSERT INTO vehicle_faults (
      user_id, vehicle_id, code, description, severity, check_engine, source,
      inspection_id, blocks_dispatch, reported_by_team_member_id
    ) VALUES (
      v_owner, p_vehicle_id, 'DVIR:DRIVER_UNSAFE', 'Driver declared vehicle unsafe: ' || left(btrim(p_notes), 260),
      'critical', false, 'dvir', v_id, true, v_tm
    )
    ON CONFLICT (vehicle_id, code) WHERE cleared_at IS NULL DO UPDATE SET
      last_seen_at = now(), description = EXCLUDED.description, blocks_dispatch = true, severity = 'critical';
  END IF;

  UPDATE vehicles SET odometer_miles = GREATEST(COALESCE(odometer_miles, 0), p_odometer_miles) WHERE id = p_vehicle_id;

  IF v_status = 'unsafe' THEN
    IF v_vehicle.assigned_technician_id IS NOT NULL THEN
      SELECT count(*)::integer INTO v_jobs FROM jobs
      WHERE assigned_technician_id = v_vehicle.assigned_technician_id
        AND job_status = 'scheduled' AND scheduled_datetime::date >= current_date;
    END IF;
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (
      v_owner, 'vehicle_unsafe', 'Vehicle out of service: ' || v_vehicle.label,
      format('%s defect(s) reported on a %s inspection; dispatch is blocked until resolved.%s', v_defects, replace(p_inspection_type, '_', '-'),
             CASE WHEN v_jobs > 0 THEN format(' %s scheduled job(s) affected.', v_jobs) ELSE '' END),
      '/dashboard/fleet-dvir'
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok', 'duplicate', false, 'inspection_id', v_id, 'result_status', v_status,
    'defect_count', v_defects, 'blocked', v_status = 'unsafe', 'odometer_anomaly', v_anomaly
  );
END;
$$;
REVOKE ALL ON FUNCTION public.submit_vehicle_inspection(uuid, text, numeric, jsonb, text, boolean, text, text, uuid, double precision, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_vehicle_inspection(uuid, text, numeric, jsonb, text, boolean, text, text, uuid, double precision, double precision) TO authenticated;

-- =============================================================
-- 7. RESOLVE DEFECT (staff only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.resolve_vehicle_defect(p_fault_id uuid, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_fault record;
  v_still boolean;
BEGIN
  IF v_owner IS NULL OR NOT public.dvir_caller_is_staff() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF char_length(btrim(COALESCE(p_note, ''))) < 3 THEN RAISE EXCEPTION 'Describe the repair or reason'; END IF;

  SELECT id, vehicle_id INTO v_fault FROM vehicle_faults
  WHERE id = p_fault_id AND user_id = v_owner AND source = 'dvir' AND cleared_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;

  UPDATE vehicle_faults
  SET cleared_at = now(), resolution_note = left(btrim(p_note), 1000), resolved_by = auth.uid()
  WHERE id = p_fault_id;

  SELECT EXISTS (SELECT 1 FROM vehicle_faults WHERE vehicle_id = v_fault.vehicle_id AND cleared_at IS NULL AND blocks_dispatch)
  INTO v_still;
  RETURN jsonb_build_object('status', 'resolved', 'still_blocked', v_still);
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_vehicle_defect(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_vehicle_defect(uuid, text) TO authenticated;

-- =============================================================
-- 8. BEST-EFFORT PATCH of assign_technician_to_job()
--    Auto-pick skips blocked technicians; manual assign returns a clear status.
--    Skipped silently (NOTICE) if the function's text differs — the trigger still enforces the block.
-- =============================================================

DO $$
DECLARE
  v_def text;
  v_new text;
  m_auto constant text := 'CONTINUE WHEN array_length(public.technician_compliance_gaps(v_tech.id, v_job.service_type), 1) > 0;';
  m_manual constant text := E'    UPDATE jobs SET assigned_technician_id = p_technician_id WHERE id = p_job_id;';
BEGIN
  v_def := pg_get_functiondef('public.assign_technician_to_job(uuid, uuid)'::regprocedure);
  IF position('dvir_technician_blocked' IN v_def) > 0 THEN RETURN; END IF;
  v_new := replace(v_def, m_auto, m_auto || E'\n    CONTINUE WHEN public.dvir_technician_blocked(v_tech.id);');
  v_new := replace(v_new, m_manual,
    E'    IF public.dvir_technician_blocked(p_technician_id) THEN\n' ||
    E'      RETURN jsonb_build_object(''status'', ''blocked_vehicle'', ''technician_id'', p_technician_id, ''technician_name'', v_tech.member_name,\n' ||
    E'        ''reason'', format(''%s''''s vehicle is out of service (open DVIR safety defect).'', v_tech.member_name));\n' ||
    E'    END IF;\n' || m_manual);
  IF v_new = v_def THEN
    RAISE NOTICE 'assign_technician_to_job() not patched (markers not found); DVIR trigger still enforces the block.';
    RETURN;
  END IF;
  EXECUTE v_new;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'assign_technician_to_job() DVIR patch skipped: %', SQLERRM;
END $$;
