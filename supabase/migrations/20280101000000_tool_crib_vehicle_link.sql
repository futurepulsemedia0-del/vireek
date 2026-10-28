/*
  # Tool crib -> vehicle link

  Additive. Lets a check-out say which truck the tool goes on.

  - tool_crib_loans.vehicle_id    FK to vehicles (SET NULL if the vehicle is deleted)
  - tool_crib_loans.vehicle_label snapshot, so history survives renames/deletes
  - check_out_crib_tool           gains optional p_vehicle_id (validated: same account, not retired)
  - tool_crib_options             also returns the account's non-retired vehicles

  The old 5-argument check_out_crib_tool is DROPPED first; leaving it would make
  PostgREST fail named-argument calls with "could not choose the best candidate function".
  Double check-out protection is unchanged (row lock + status check + partial unique index).
*/

ALTER TABLE tool_crib_loans
  ADD COLUMN IF NOT EXISTS vehicle_id uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vehicle_label text;

CREATE INDEX IF NOT EXISTS idx_tool_crib_loans_vehicle
  ON tool_crib_loans (vehicle_id) WHERE vehicle_id IS NOT NULL;

-- =============================================================
-- RPC: check_out_crib_tool (now with optional vehicle)
-- =============================================================

DROP FUNCTION IF EXISTS public.check_out_crib_tool(uuid, uuid, integer, text, text);

CREATE OR REPLACE FUNCTION public.check_out_crib_tool(
  p_tool_id uuid,
  p_technician_id uuid,
  p_loan_hours integer DEFAULT NULL,
  p_condition text DEFAULT 'good',
  p_note text DEFAULT NULL,
  p_vehicle_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tool tool_crib_items%ROWTYPE;
  v_tm team_members%ROWTYPE;
  v_veh vehicles%ROWTYPE;
  v_set record;
  v_cond text := COALESCE(p_condition, 'good');
  v_hours integer;
  v_due timestamptz;
  v_loan_id uuid;
  v_tech_name text;
  v_veh_label text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF v_cond NOT IN ('good', 'worn') THEN
    RAISE EXCEPTION 'Condition must be good or worn (report damaged tools as maintenance)';
  END IF;
  IF p_loan_hours IS NOT NULL AND (p_loan_hours < 1 OR p_loan_hours > 720) THEN
    RAISE EXCEPTION 'Loan length must be between 1 and 720 hours';
  END IF;

  SELECT * INTO v_tool
  FROM tool_crib_items i
  WHERE i.id = p_tool_id AND i.user_id = v_owner
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tool not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_tm
  FROM team_members tm
  WHERE tm.id = p_technician_id
    AND tm.account_owner_id = v_owner
    AND tm.invite_status IN ('accepted', 'active');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Choose an active team member to take this tool';
  END IF;

  IF public.tool_crib_is_self_only() AND v_tm.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'You can only check tools out to yourself' USING ERRCODE = '42501';
  END IF;

  IF v_tool.status <> 'available' THEN
    RAISE EXCEPTION '%', CASE v_tool.status
      WHEN 'checked_out' THEN 'This tool is already checked out'
      WHEN 'maintenance' THEN 'This tool is in maintenance and cannot be checked out'
      WHEN 'lost' THEN 'This tool is marked lost'
      ELSE 'This tool is retired'
    END USING ERRCODE = 'P0004';
  END IF;

  IF p_vehicle_id IS NOT NULL THEN
    SELECT * INTO v_veh
    FROM vehicles v
    WHERE v.id = p_vehicle_id AND v.user_id = v_owner AND v.status <> 'retired';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Choose an active vehicle from your fleet';
    END IF;
    v_veh_label := v_veh.label ||
      CASE WHEN NULLIF(btrim(COALESCE(v_veh.license_plate, '')), '') IS NULL
           THEN '' ELSE ' (' || btrim(v_veh.license_plate) || ')' END;
  END IF;

  SELECT * INTO v_set FROM public.tool_crib_settings_for(v_owner);
  v_hours := COALESCE(p_loan_hours, v_tool.default_loan_hours, v_set.loan_hours);
  v_due := now() + make_interval(hours => v_hours);
  v_tech_name := COALESCE(NULLIF(btrim(v_tm.member_name), ''), v_tm.member_email);

  INSERT INTO tool_crib_loans (
    user_id, tool_id, tool_name, tool_number, technician_id, technician_name,
    vehicle_id, vehicle_label, checked_out_by, due_at, out_condition, out_note
  )
  VALUES (
    v_owner, v_tool.id, v_tool.name, v_tool.tool_number, v_tm.id, v_tech_name,
    v_veh.id, v_veh_label, auth.uid(), v_due, v_cond,
    NULLIF(left(btrim(COALESCE(p_note, '')), 500), '')
  )
  RETURNING id INTO v_loan_id;

  UPDATE tool_crib_items SET status = 'checked_out', updated_at = now() WHERE id = v_tool.id;

  PERFORM public.tool_crib_log(
    v_owner, v_tool.id, v_loan_id, 'checked_out',
    'Taken by ' || v_tech_name ||
      CASE WHEN v_veh_label IS NULL THEN '' ELSE ' on ' || v_veh_label END ||
      ', due ' || to_char(v_due AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC'
  );

  RETURN jsonb_build_object(
    'loan_id', v_loan_id,
    'tool_name', v_tool.name,
    'technician_name', v_tech_name,
    'vehicle_label', v_veh_label,
    'due_at', v_due
  );
END;
$$;

-- =============================================================
-- RPC: tool_crib_options (adds vehicles)
-- =============================================================

CREATE OR REPLACE FUNCTION public.tool_crib_options()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_set record;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_set FROM public.tool_crib_settings_for(v_owner);

  RETURN jsonb_build_object(
    'technicians', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object('id', t.id, 'name', t.nm, 'role', t.role)
               ORDER BY (t.role <> 'technician'), t.nm
             )
      FROM (
        SELECT tm.id, tm.role, COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email) AS nm
        FROM team_members tm
        WHERE tm.account_owner_id = v_owner
          AND tm.invite_status IN ('accepted', 'active')
      ) t
    ), '[]'::jsonb),
    'vehicles', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'id', v.id,
                 'label', v.label,
                 'plate', v.license_plate,
                 'assigned_technician_id', v.assigned_technician_id
               )
               ORDER BY v.label
             )
      FROM vehicles v
      WHERE v.user_id = v_owner AND v.status <> 'retired'
    ), '[]'::jsonb),
    'self_member_id', public.tool_crib_own_member_id(),
    'self_only', public.tool_crib_is_self_only(),
    'can_manage', public.tool_crib_perm('can_manage_team'),
    'settings', jsonb_build_object(
      'default_loan_hours', v_set.loan_hours,
      'lost_after_hours', v_set.lost_hours,
      'alerts_enabled', v_set.alerts_on
    )
  );
END;
$$;

-- =============================================================
-- GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.check_out_crib_tool(uuid, uuid, integer, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_out_crib_tool(uuid, uuid, integer, text, text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.tool_crib_options() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tool_crib_options() TO authenticated;
