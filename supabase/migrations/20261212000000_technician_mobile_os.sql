-- =============================================================
-- BUGFIX: get_account_owner_id() never fell through to the
-- team_members branch, because every authenticated user already
-- has a profiles row (id = auth.uid()). Team members therefore
-- resolved to themselves instead of the account owner.
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_account_owner_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT account_owner_id FROM team_members WHERE user_id = auth.uid() LIMIT 1),
    (SELECT id FROM profiles WHERE id = auth.uid())
  );
$$;

-- =============================================================
-- JOBS: mobile-OS fields
-- =============================================================
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS arrived_at timestamptz,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS expected_duration_minutes integer,
  ADD COLUMN IF NOT EXISTS safety_flag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS safety_flag_note text;

-- =============================================================
-- JOB_STATUS_EVENTS: field timeline / audit trail
-- =============================================================
CREATE TABLE IF NOT EXISTS job_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  from_status text,
  to_status text NOT NULL,
  note text,
  latitude numeric,
  longitude numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_status_events_job_id ON job_status_events(job_id);

ALTER TABLE job_status_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_job_status_events" ON job_status_events;
CREATE POLICY "select_job_status_events" ON job_status_events FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND j.user_id = public.get_account_owner_id()));

DROP POLICY IF EXISTS "insert_job_status_events" ON job_status_events;
CREATE POLICY "insert_job_status_events" ON job_status_events FOR INSERT TO authenticated
WITH CHECK (
  technician_id = public.get_my_team_member_id()
  AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND j.assigned_technician_id = public.get_my_team_member_id())
);

-- =============================================================
-- HELPER: resolve the calling user's own team_members.id
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_my_team_member_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM team_members WHERE user_id = auth.uid() LIMIT 1;
$$;

-- =============================================================
-- RPC: today's jobs for the logged-in technician
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_technician_today_jobs(p_date date DEFAULT current_date)
RETURNS TABLE (
  id uuid, customer_name text, address text, service_type text,
  scheduled_datetime timestamptz, job_status text,
  arrived_at timestamptz, started_at timestamptz, completed_at timestamptz,
  expected_duration_minutes integer, safety_flag boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT j.id, j.customer_name, j.address, j.service_type, j.scheduled_datetime, j.job_status,
         j.arrived_at, j.started_at, j.completed_at, j.expected_duration_minutes, j.safety_flag
  FROM jobs j
  WHERE j.assigned_technician_id = public.get_my_team_member_id()
    AND j.scheduled_datetime::date = p_date
  ORDER BY j.scheduled_datetime ASC NULLS LAST;
$$;

-- =============================================================
-- RPC: the full Job Brief (the core of this feature)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_job_brief(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_my_tm_id uuid;
  v_is_owner_admin boolean;
  v_result jsonb;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id;
  IF v_job.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  v_my_tm_id := public.get_my_team_member_id();
  SELECT (role IN ('owner','admin')) INTO v_is_owner_admin FROM profiles WHERE id = auth.uid();

  IF NOT (
    v_job.assigned_technician_id = v_my_tm_id
    OR (COALESCE(v_is_owner_admin, false) AND v_job.user_id = public.get_account_owner_id())
  ) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id, 'customer_name', v_job.customer_name, 'address', v_job.address,
      'service_type', v_job.service_type, 'scheduled_datetime', v_job.scheduled_datetime,
      'job_status', v_job.job_status, 'arrived_at', v_job.arrived_at, 'started_at', v_job.started_at,
      'completed_at', v_job.completed_at, 'expected_duration_minutes', v_job.expected_duration_minutes,
      'safety_flag', v_job.safety_flag, 'safety_flag_note', v_job.safety_flag_note,
      'notes', v_job.notes, 'invoice_amount', v_job.invoice_amount
    ),
    'customer', (
      SELECT jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'address', c.address,
                                 'lifecycle_stage', c.lifecycle_stage, 'tags', c.tags)
      FROM customers c WHERE c.id = v_job.customer_id
    ),
    'equipment', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', e.id, 'equipment_type', e.equipment_type, 'make', e.make, 'model', e.model,
        'serial_number', e.serial_number, 'install_date', e.install_date,
        'warranty_expires_at', e.warranty_expires_at, 'warranty_notes', e.warranty_notes,
        'notes', e.notes, 'status', e.status
      ))
      FROM equipment e WHERE e.customer_id = v_job.customer_id AND e.status = 'active'
    ), '[]'::jsonb),
    'previous_notes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('job_id', j2.id, 'date', j2.scheduled_datetime,
                                           'service_type', j2.service_type, 'notes', j2.notes)
                        ORDER BY j2.scheduled_datetime DESC)
      FROM (
        SELECT id, scheduled_datetime, service_type, notes FROM jobs
        WHERE customer_id = v_job.customer_id AND id <> v_job.id
          AND notes IS NOT NULL AND notes <> ''
        ORDER BY scheduled_datetime DESC LIMIT 5
      ) j2
    ), '[]'::jsonb),
    'warranty_claims', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', w.id, 'status', w.status, 'manufacturer', w.manufacturer,
                                           'model_number', w.model_number, 'failure_description', w.failure_description))
      FROM warranty_claims w
      WHERE w.job_id = v_job.id OR w.equipment_id IN (SELECT id FROM equipment WHERE customer_id = v_job.customer_id)
    ), '[]'::jsonb),
    'likely_diagnosis', (
      SELECT jsonb_build_object('severity', d.severity, 'confidence', d.confidence,
                                 'ai_result', d.ai_result, 'created_at', d.created_at)
      FROM diagnosis_sessions d
      WHERE d.job_id = v_job.id OR d.equipment_id IN (SELECT id FROM equipment WHERE customer_id = v_job.customer_id)
      ORDER BY d.created_at DESC LIMIT 1
    ),
    'customer_preferences', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('category', cm.category, 'fact', cm.fact) ORDER BY cm.created_at DESC)
      FROM customer_memory cm WHERE cm.customer_phone = (SELECT phone FROM customers WHERE id = v_job.customer_id)
    ), '[]'::jsonb),
    'parts_check', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'part_name', ip.name, 'required_qty', spk.quantity, 'on_hand_qty', COALESCE(isl.quantity_on_hand, 0),
        'shortage', GREATEST(spk.quantity - COALESCE(isl.quantity_on_hand, 0), 0)
      ))
      FROM service_part_kits spk
      JOIN inventory_parts ip ON ip.id = spk.part_id
      LEFT JOIN inventory_locations il ON il.assigned_technician_id = v_job.assigned_technician_id AND il.location_type = 'van'
      LEFT JOIN inventory_stock_levels isl ON isl.part_id = spk.part_id AND isl.location_id = il.id
      WHERE spk.service_type = v_job.service_type
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- =============================================================
-- RPC: advance job status (tap-through stepper) + timeline log
-- =============================================================
CREATE OR REPLACE FUNCTION public.advance_job_status(
  p_job_id uuid, p_new_status text, p_note text DEFAULT NULL,
  p_lat numeric DEFAULT NULL, p_lng numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_my_tm_id uuid;
BEGIN
  IF p_new_status NOT IN ('scheduled','en_route','in_progress','completed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status');
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id;
  IF v_job.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found');
  END IF;

  v_my_tm_id := public.get_my_team_member_id();
  IF v_job.assigned_technician_id IS DISTINCT FROM v_my_tm_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden');
  END IF;

  UPDATE jobs SET
    job_status = p_new_status,
    arrived_at = CASE WHEN p_new_status = 'en_route' AND arrived_at IS NULL THEN now() ELSE arrived_at END,
    started_at = CASE WHEN p_new_status = 'in_progress' AND started_at IS NULL THEN now() ELSE started_at END,
    completed_at = CASE WHEN p_new_status = 'completed' THEN now() ELSE completed_at END
  WHERE id = p_job_id;

  INSERT INTO job_status_events (job_id, technician_id, from_status, to_status, note, latitude, longitude)
  VALUES (p_job_id, v_my_tm_id, v_job.job_status, p_new_status, p_note, p_lat, p_lng);

  RETURN jsonb_build_object('success', true);
END;
$$;

-- =============================================================
-- RPC: safety flag + field note
-- =============================================================
CREATE OR REPLACE FUNCTION public.set_job_safety_flag(p_job_id uuid, p_flag boolean, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_my_tm_id uuid; v_assigned uuid;
BEGIN
  v_my_tm_id := public.get_my_team_member_id();
  SELECT assigned_technician_id INTO v_assigned FROM jobs WHERE id = p_job_id;
  IF v_assigned IS DISTINCT FROM v_my_tm_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden');
  END IF;
  UPDATE jobs SET safety_flag = p_flag, safety_flag_note = p_note WHERE id = p_job_id;
  RETURN jsonb_build_object('success', true);
END; $$;

CREATE OR REPLACE FUNCTION public.add_job_note(p_job_id uuid, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_my_tm_id uuid; v_assigned uuid;
BEGIN
  v_my_tm_id := public.get_my_team_member_id();
  SELECT assigned_technician_id INTO v_assigned FROM jobs WHERE id = p_job_id;
  IF v_assigned IS DISTINCT FROM v_my_tm_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden');
  END IF;
  UPDATE jobs SET notes = COALESCE(notes || E'\n\n', '') || '[' || to_char(now(), 'YYYY-MM-DD HH24:MI') || '] ' || p_note
  WHERE id = p_job_id;
  RETURN jsonb_build_object('success', true);
END; $$;

GRANT EXECUTE ON FUNCTION public.get_my_team_member_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_technician_today_jobs(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_job_brief(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.advance_job_status(uuid, text, text, numeric, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_job_safety_flag(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_job_note(uuid, text) TO authenticated;
