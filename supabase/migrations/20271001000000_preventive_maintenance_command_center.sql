/*
  # Preventive Maintenance Command Center

  Adds ONLY the workflow state the command center needs. Every maintenance signal
  (overdue / upcoming / contract / warranty / seasonal / high-risk) is derived at read time
  from tables that already exist (equipment, equipment_maintenance_alerts, pfn_forecasts,
  commercial_contracts, jobs, team_members, parts_availability, service_part_kits), so no
  detection logic is duplicated or can drift.

  Objects (all additive, nothing existing is altered except one new trigger on jobs):
    - pm_settings        per-account thresholds
    - pm_work_items      one ACTIVE row per unit: the planned -> scheduled -> notified -> completed loop
    - pm_schedule_visit  atomic RPC: job + job_equipment + technician (existing assign_technician_to_job,
                         so capacity + compliance gates apply) + parts reservations + work item
    - pm_sync_job_outcome trigger: job completed -> work item completed + equipment.last_service_date
                         advances; job cancelled / no_show -> unit returns to the queue, reservations released
*/

-- 1) Settings ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pm_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  due_soon_days integer NOT NULL DEFAULT 45 CHECK (due_soon_days BETWEEN 7 AND 180),
  risk_threshold numeric(3, 2) NOT NULL DEFAULT 0.35 CHECK (risk_threshold BETWEEN 0.05 AND 0.95),
  seasonal_enabled boolean NOT NULL DEFAULT true,
  hemisphere text NOT NULL DEFAULT 'north' CHECK (hemisphere IN ('north', 'south')),
  default_visit_minutes integer NOT NULL DEFAULT 60 CHECK (default_visit_minutes BETWEEN 15 AND 480),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pm_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pm_settings_select" ON public.pm_settings;
CREATE POLICY "pm_settings_select" ON public.pm_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pm_settings_insert" ON public.pm_settings;
CREATE POLICY "pm_settings_insert" ON public.pm_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pm_settings_update" ON public.pm_settings;
CREATE POLICY "pm_settings_update" ON public.pm_settings FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND user_id = public.get_account_owner_id())
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());

-- 2) Work items -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pm_work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES public.equipment(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'scheduled', 'notified', 'completed', 'dismissed', 'snoozed')),
  signals text[] NOT NULL DEFAULT '{}'
    CHECK (signals <@ ARRAY['overdue', 'upcoming', 'contract', 'warranty', 'seasonal', 'high_risk']::text[]),
  priority_score integer NOT NULL DEFAULT 0 CHECK (priority_score BETWEEN 0 AND 100),
  due_by date,
  snoozed_until date,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  technician_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  scheduled_at timestamptz,
  assignment_status text,
  parts_status text NOT NULL DEFAULT 'none' CHECK (parts_status IN ('none', 'reserved', 'partial', 'backordered')),
  parts_detail jsonb NOT NULL DEFAULT '[]'::jsonb,
  notified_at timestamptz,
  notified_channel text CHECK (notified_channel IS NULL OR notified_channel IN ('sms', 'email')),
  notify_error text,
  completed_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One ACTIVE work item per unit; completed / dismissed rows are history.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_work_items_active_equipment
  ON public.pm_work_items(equipment_id)
  WHERE status IN ('planned', 'scheduled', 'notified', 'snoozed');
CREATE INDEX IF NOT EXISTS idx_pm_work_items_user_status ON public.pm_work_items(user_id, status);
CREATE INDEX IF NOT EXISTS idx_pm_work_items_job ON public.pm_work_items(job_id) WHERE job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.pm_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pm_work_items_touch ON public.pm_work_items;
CREATE TRIGGER trg_pm_work_items_touch BEFORE UPDATE ON public.pm_work_items
  FOR EACH ROW EXECUTE FUNCTION public.pm_touch_updated_at();

ALTER TABLE public.pm_work_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pm_work_items_select" ON public.pm_work_items;
CREATE POLICY "pm_work_items_select" ON public.pm_work_items FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pm_work_items_insert" ON public.pm_work_items;
CREATE POLICY "pm_work_items_insert" ON public.pm_work_items FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.equipment e WHERE e.id = equipment_id AND e.user_id = public.get_account_owner_id())
  );
DROP POLICY IF EXISTS "pm_work_items_update" ON public.pm_work_items;
CREATE POLICY "pm_work_items_update" ON public.pm_work_items FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
-- No DELETE policy: work items are an audit trail.

-- 3) Atomic scheduling RPC --------------------------------------------------
CREATE OR REPLACE FUNCTION public.pm_schedule_visit(
  p_equipment_id uuid,
  p_scheduled_at timestamptz,
  p_technician_id uuid DEFAULT NULL,
  p_duration_minutes integer DEFAULT 60,
  p_service_type text DEFAULT NULL,
  p_signals text[] DEFAULT '{}',
  p_priority_score integer DEFAULT 0,
  p_due_by date DEFAULT NULL,
  p_parts jsonb DEFAULT '[]'::jsonb,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_eq record;
  v_cust record;
  v_item_id uuid;
  v_item_job uuid;
  v_job_status text;
  v_job_id uuid;
  v_service text;
  v_assign jsonb;
  v_line jsonb;
  v_part_id uuid;
  v_loc_id uuid;
  v_qty integer;
  v_avail integer;
  v_reserved integer := 0;
  v_short integer := 0;
  v_lines jsonb := '[]'::jsonb;
  v_parts_status text := 'none';
  v_tech uuid;
  v_signals text[] := COALESCE(p_signals, '{}');
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF p_scheduled_at IS NULL OR p_scheduled_at < now() - interval '1 hour' THEN RAISE EXCEPTION 'INVALID_SCHEDULE'; END IF;
  IF p_duration_minutes IS NULL OR p_duration_minutes NOT BETWEEN 15 AND 720 THEN RAISE EXCEPTION 'INVALID_DURATION'; END IF;
  IF NOT (v_signals <@ ARRAY['overdue', 'upcoming', 'contract', 'warranty', 'seasonal', 'high_risk']::text[]) THEN
    RAISE EXCEPTION 'INVALID_SIGNALS';
  END IF;

  SELECT id, customer_id, equipment_type, status INTO v_eq
  FROM equipment WHERE id = p_equipment_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'EQUIPMENT_NOT_FOUND'; END IF;
  IF v_eq.status <> 'active' THEN RAISE EXCEPTION 'EQUIPMENT_INACTIVE'; END IF;

  SELECT id, name, phone, address INTO v_cust
  FROM customers WHERE id = v_eq.customer_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOMER_NOT_FOUND'; END IF;

  IF p_technician_id IS NOT NULL THEN
    PERFORM 1 FROM team_members WHERE id = p_technician_id AND account_owner_id = v_owner;
    IF NOT FOUND THEN RAISE EXCEPTION 'TECHNICIAN_NOT_FOUND'; END IF;
  END IF;

  SELECT id, job_id INTO v_item_id, v_item_job
  FROM pm_work_items
  WHERE equipment_id = p_equipment_id AND user_id = v_owner
    AND status IN ('planned', 'scheduled', 'notified', 'snoozed')
  FOR UPDATE;

  IF v_item_id IS NOT NULL AND v_item_job IS NOT NULL THEN
    SELECT job_status INTO v_job_status FROM jobs WHERE id = v_item_job;
    IF v_job_status IN ('scheduled', 'en_route', 'in_progress') THEN RAISE EXCEPTION 'ALREADY_SCHEDULED'; END IF;
  END IF;

  v_service := left(COALESCE(NULLIF(btrim(p_service_type), ''), COALESCE(v_eq.equipment_type, 'Equipment') || ' Maintenance'), 120);

  INSERT INTO jobs (
    user_id, customer_id, customer_name, customer_phone, address, service_type,
    scheduled_datetime, duration_minutes, job_status, invoice_status, tags, dispatch_note
  ) VALUES (
    v_owner, v_cust.id, v_cust.name, v_cust.phone, v_cust.address, v_service,
    p_scheduled_at, p_duration_minutes, 'scheduled', 'not_sent', ARRAY['preventive_maintenance'],
    left(NULLIF(btrim(p_note), ''), 1000)
  ) RETURNING id INTO v_job_id;

  INSERT INTO job_equipment (job_id, equipment_id, service_type)
  VALUES (v_job_id, p_equipment_id, 'maintenance')
  ON CONFLICT DO NOTHING;

  -- Existing assignment logic: capacity + credential compliance gates. NULL technician = auto-pick best.
  v_assign := public.assign_technician_to_job(v_job_id, p_technician_id);

  IF jsonb_typeof(COALESCE(p_parts, '[]'::jsonb)) = 'array' THEN
    FOR v_line IN SELECT value FROM jsonb_array_elements(COALESCE(p_parts, '[]'::jsonb)) LOOP
      v_part_id := NULLIF(v_line->>'part_id', '')::uuid;
      v_loc_id := NULLIF(v_line->>'location_id', '')::uuid;
      v_qty := GREATEST(1, LEAST(COALESCE((v_line->>'quantity')::integer, 1), 100));
      CONTINUE WHEN v_part_id IS NULL OR v_loc_id IS NULL;

      PERFORM 1 FROM inventory_parts WHERE id = v_part_id AND user_id = v_owner;
      CONTINUE WHEN NOT FOUND;

      SELECT (sl.quantity_on_hand - sl.quantity_reserved) INTO v_avail
      FROM inventory_stock_levels sl
      WHERE sl.part_id = v_part_id AND sl.location_id = v_loc_id AND sl.user_id = v_owner
      FOR UPDATE;
      IF NOT FOUND THEN v_avail := 0; END IF;

      IF v_avail >= v_qty THEN
        INSERT INTO inventory_reservations (user_id, part_id, location_id, job_id, quantity, status)
        VALUES (v_owner, v_part_id, v_loc_id, v_job_id, v_qty, 'active');
        INSERT INTO job_parts_required (user_id, job_id, part_id, quantity_required, status)
        VALUES (v_owner, v_job_id, v_part_id, v_qty, 'allocated')
        ON CONFLICT (job_id, part_id) DO UPDATE
          SET quantity_required = EXCLUDED.quantity_required, status = 'allocated', updated_at = now();
        v_reserved := v_reserved + 1;
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'part_id', v_part_id, 'location_id', v_loc_id, 'quantity', v_qty, 'status', 'reserved'));
      ELSE
        INSERT INTO job_parts_required (user_id, job_id, part_id, quantity_required, status)
        VALUES (v_owner, v_job_id, v_part_id, v_qty, 'backordered')
        ON CONFLICT (job_id, part_id) DO UPDATE
          SET quantity_required = EXCLUDED.quantity_required, status = 'backordered', updated_at = now();
        v_short := v_short + 1;
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'part_id', v_part_id, 'location_id', v_loc_id, 'quantity', v_qty, 'status', 'backordered'));
      END IF;
    END LOOP;
  END IF;

  v_parts_status := CASE
    WHEN v_reserved + v_short = 0 THEN 'none'
    WHEN v_short = 0 THEN 'reserved'
    WHEN v_reserved = 0 THEN 'backordered'
    ELSE 'partial'
  END;

  v_tech := CASE WHEN v_assign->>'status' = 'assigned' THEN (v_assign->>'technician_id')::uuid ELSE NULL END;

  IF v_item_id IS NOT NULL THEN
    UPDATE pm_work_items SET
      status = 'scheduled', signals = v_signals,
      priority_score = LEAST(100, GREATEST(0, COALESCE(p_priority_score, 0))),
      due_by = p_due_by, snoozed_until = NULL, job_id = v_job_id, technician_id = v_tech,
      scheduled_at = p_scheduled_at, assignment_status = v_assign->>'status',
      parts_status = v_parts_status, parts_detail = v_lines,
      notified_at = NULL, notified_channel = NULL, notify_error = NULL, completed_at = NULL
    WHERE id = v_item_id;
  ELSE
    INSERT INTO pm_work_items (
      user_id, equipment_id, customer_id, status, signals, priority_score, due_by, job_id, technician_id,
      scheduled_at, assignment_status, parts_status, parts_detail
    ) VALUES (
      v_owner, p_equipment_id, v_cust.id, 'scheduled', v_signals,
      LEAST(100, GREATEST(0, COALESCE(p_priority_score, 0))), p_due_by, v_job_id, v_tech,
      p_scheduled_at, v_assign->>'status', v_parts_status, v_lines
    ) RETURNING id INTO v_item_id;
  END IF;

  RETURN jsonb_build_object(
    'work_item_id', v_item_id, 'job_id', v_job_id, 'assignment', v_assign,
    'parts_status', v_parts_status, 'parts', v_lines
  );
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'ALREADY_SCHEDULED';
END;
$$;

REVOKE ALL ON FUNCTION public.pm_schedule_visit(uuid, timestamptz, uuid, integer, text, text[], integer, date, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_schedule_visit(uuid, timestamptz, uuid, integer, text, text[], integer, date, jsonb, text) TO authenticated;

-- 4) Close the loop when the job finishes or falls through --------------------
CREATE OR REPLACE FUNCTION public.pm_sync_job_outcome()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_equipment_id uuid;
BEGIN
  IF NEW.job_status = 'completed' THEN
    UPDATE pm_work_items SET status = 'completed', completed_at = now()
    WHERE job_id = NEW.id AND status IN ('scheduled', 'notified')
    RETURNING equipment_id INTO v_equipment_id;

    IF v_equipment_id IS NOT NULL THEN
      UPDATE equipment
      SET last_service_date = GREATEST(COALESCE(last_service_date, DATE '1900-01-01'), CURRENT_DATE)
      WHERE id = v_equipment_id;

      UPDATE jobs j
      SET next_maintenance_date = CURRENT_DATE + make_interval(months => GREATEST(1, e.service_interval_months))
      FROM equipment e
      WHERE j.id = NEW.id AND e.id = v_equipment_id AND j.next_maintenance_date IS NULL;
    END IF;
  ELSIF NEW.job_status IN ('cancelled', 'no_show') THEN
    UPDATE pm_work_items SET
      status = 'planned', job_id = NULL, technician_id = NULL, scheduled_at = NULL, assignment_status = NULL,
      parts_status = 'none', parts_detail = '[]'::jsonb,
      notified_at = NULL, notified_channel = NULL, notify_error = NULL
    WHERE job_id = NEW.id AND status IN ('scheduled', 'notified');

    IF FOUND THEN
      UPDATE inventory_reservations SET status = 'released', released_at = now()
      WHERE job_id = NEW.id AND status = 'active';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_pm_sync_job_outcome ON public.jobs;
CREATE TRIGGER trg_pm_sync_job_outcome
  AFTER UPDATE OF job_status ON public.jobs
  FOR EACH ROW
  WHEN (OLD.job_status IS DISTINCT FROM NEW.job_status AND NEW.job_status IN ('completed', 'cancelled', 'no_show'))
  EXECUTE FUNCTION public.pm_sync_job_outcome();
