/*
  # Tool crib (/dashboard/tools)

  Check-out / check-in of shared tools (drills, meters, ladders, pullers...)
  per technician, with overdue and lost alerts. Additive only: no existing
  table is altered.

  ## Tables
  - tool_crib_items     one row per physical tool (tag number, barcode, status)
  - tool_crib_loans     one row per check-out (who, when, due, condition, outcome)
  - tool_crib_events    audit timeline (created, checked out/in, extended, lost...)
  - tool_crib_settings  per-account defaults (loan length, lost threshold, alerts)

  ## Security model (same as inventory_cycle_counts)
  - Every row carries user_id = the ACCOUNT OWNER's id (public.get_account_owner_id()),
    so owners and team members share one crib.
  - Account members can only SELECT. All writes go through SECURITY DEFINER RPCs
    that re-check membership, status and permissions.
  - Managing the crib (add/edit tools, mark lost, recover, retire, settings)
    needs can_manage_team (owner always; custom-role permissions override
    team_members.permissions, matching AuthContext).
  - A technician WITHOUT can_manage_team can only check tools out to
    themselves and only return / extend their own loans.

  ## Alerts
  - Overdue: a loan still 'out' after due_at.
  - Suspected lost: still 'out' lost_after_hours after due_at.
  - scan_crib_tool_alerts() writes ONE aggregated notification per stage per
    scan and stamps each loan, so a loan alerts at most once per stage
    (an extension clears the stamps). The page calls it on load and every few
    minutes. Optional pg_cron (see bottom) runs it for every account too.
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS tool_crib_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  default_loan_hours integer NOT NULL DEFAULT 24 CHECK (default_loan_hours BETWEEN 1 AND 720),
  lost_after_hours integer NOT NULL DEFAULT 72 CHECK (lost_after_hours BETWEEN 1 AND 2160),
  alerts_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tool_crib_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tool_number text NOT NULL CHECK (char_length(btrim(tool_number)) BETWEEN 1 AND 40),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  category text,
  serial_number text,
  barcode text,
  purchase_cost_cents integer CHECK (purchase_cost_cents IS NULL OR purchase_cost_cents >= 0),
  default_loan_hours integer CHECK (default_loan_hours IS NULL OR default_loan_hours BETWEEN 1 AND 720),
  status text NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'checked_out', 'maintenance', 'lost', 'retired')),
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tool_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_crib_items_barcode
  ON tool_crib_items (user_id, lower(barcode)) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tool_crib_items_user_status
  ON tool_crib_items (user_id, status);

CREATE TABLE IF NOT EXISTS tool_crib_loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tool_id uuid NOT NULL REFERENCES tool_crib_items(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  tool_number text NOT NULL,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  technician_name text NOT NULL,
  status text NOT NULL DEFAULT 'out' CHECK (status IN ('out', 'returned', 'lost')),
  checked_out_at timestamptz NOT NULL DEFAULT now(),
  checked_out_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  due_at timestamptz NOT NULL,
  out_condition text NOT NULL DEFAULT 'good' CHECK (out_condition IN ('good', 'worn')),
  out_note text,
  extended_count integer NOT NULL DEFAULT 0,
  returned_at timestamptz,
  returned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  return_condition text CHECK (return_condition IS NULL OR return_condition IN ('good', 'worn', 'damaged')),
  return_note text,
  lost_at timestamptz,
  lost_note text,
  overdue_alerted_at timestamptz,
  lost_alerted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A tool can have only one open loan, even under concurrent check-outs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_crib_loans_one_open
  ON tool_crib_loans (tool_id) WHERE status = 'out';
CREATE INDEX IF NOT EXISTS idx_tool_crib_loans_user_status
  ON tool_crib_loans (user_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_tool_crib_loans_tool
  ON tool_crib_loans (tool_id, checked_out_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_crib_loans_technician
  ON tool_crib_loans (technician_id);

CREATE TABLE IF NOT EXISTS tool_crib_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tool_id uuid NOT NULL REFERENCES tool_crib_items(id) ON DELETE CASCADE,
  loan_id uuid REFERENCES tool_crib_loans(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'created', 'updated', 'checked_out', 'checked_in', 'extended',
    'marked_lost', 'recovered', 'status_changed', 'overdue_alert', 'lost_alert'
  )),
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_name text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tool_crib_events_tool
  ON tool_crib_events (tool_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_crib_events_user
  ON tool_crib_events (user_id, created_at DESC);

-- =============================================================
-- RLS — read-only for account members; all writes via RPC
-- =============================================================

ALTER TABLE tool_crib_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_crib_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_crib_loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_crib_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Account members view tool crib items" ON tool_crib_items;
CREATE POLICY "Account members view tool crib items"
  ON tool_crib_items FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "Account members view tool crib loans" ON tool_crib_loans;
CREATE POLICY "Account members view tool crib loans"
  ON tool_crib_loans FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "Account members view tool crib events" ON tool_crib_events;
CREATE POLICY "Account members view tool crib events"
  ON tool_crib_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- tool_crib_settings intentionally has NO policy: read/write only through RPCs.

-- =============================================================
-- INTERNAL HELPERS (not callable by clients)
-- =============================================================

-- Owner => true. Team member => the (custom-role-overridden) permission flag.
CREATE OR REPLACE FUNCTION public.tool_crib_perm(p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
        AND tm.invite_status IN ('accepted', 'active')
        AND COALESCE(cr.permissions ->> p_key, tm.permissions ->> p_key, 'false') = 'true'
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.tool_crib_actor_name()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT NULLIF(btrim(tm.member_name), '') FROM team_members tm WHERE tm.user_id = auth.uid() LIMIT 1),
    (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
  );
$$;

-- The caller's own team_members.id inside their account (NULL for the owner).
CREATE OR REPLACE FUNCTION public.tool_crib_own_member_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tm.id
  FROM team_members tm
  WHERE tm.user_id = auth.uid()
    AND tm.account_owner_id = public.get_account_owner_id()
  LIMIT 1;
$$;

-- True for a technician who cannot manage the team: self-service only.
CREATE OR REPLACE FUNCTION public.tool_crib_is_self_only()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
           SELECT 1 FROM team_members tm
           WHERE tm.user_id = auth.uid() AND tm.role = 'technician'
         )
         AND NOT public.tool_crib_perm('can_manage_team');
$$;

CREATE OR REPLACE FUNCTION public.tool_crib_settings_for(p_owner uuid)
RETURNS TABLE (loan_hours integer, lost_hours integer, alerts_on boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(s.default_loan_hours, 24),
         COALESCE(s.lost_after_hours, 72),
         COALESCE(s.alerts_enabled, true)
  FROM (SELECT 1) one
  LEFT JOIN tool_crib_settings s ON s.user_id = p_owner;
$$;

CREATE OR REPLACE FUNCTION public.tool_crib_log(
  p_owner uuid,
  p_tool_id uuid,
  p_loan_id uuid,
  p_type text,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO tool_crib_events (user_id, tool_id, loan_id, event_type, actor_id, actor_name, note)
  VALUES (
    p_owner, p_tool_id, p_loan_id, p_type, auth.uid(), public.tool_crib_actor_name(),
    NULLIF(left(btrim(COALESCE(p_note, '')), 500), '')
  );
$$;

-- Alert pass for ONE account. Idempotent: every loan alerts once per stage.
-- Stage 2 (suspected lost) runs first and also stamps the overdue stage, so a
-- loan that jumped straight past both thresholds raises a single notification.
CREATE OR REPLACE FUNCTION public.tool_crib_scan_owner(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_set record;
  v_lost integer := 0;
  v_over integer := 0;
  v_names text;
BEGIN
  SELECT * INTO v_set FROM public.tool_crib_settings_for(p_owner);
  IF NOT v_set.alerts_on THEN
    RETURN jsonb_build_object('overdue', 0, 'suspected_lost', 0);
  END IF;

  -- Stage 2: suspected lost
  WITH hit AS (
    UPDATE tool_crib_loans l
    SET lost_alerted_at = now(),
        overdue_alerted_at = COALESCE(l.overdue_alerted_at, now()),
        updated_at = now()
    WHERE l.user_id = p_owner
      AND l.status = 'out'
      AND l.lost_alerted_at IS NULL
      AND l.due_at < now() - make_interval(hours => v_set.lost_hours)
    RETURNING l.id, l.tool_id, l.tool_name, l.technician_name
  ), ev AS (
    INSERT INTO tool_crib_events (user_id, tool_id, loan_id, event_type, actor_name, note)
    SELECT p_owner, h.tool_id, h.id, 'lost_alert', 'System', h.technician_name FROM hit h
    RETURNING 1
  )
  SELECT count(*)::integer,
         array_to_string((array_agg(h.tool_name || ' (' || h.technician_name || ')' ORDER BY h.tool_name))[1:3], ', ')
  INTO v_lost, v_names
  FROM hit h;

  IF v_lost > 0 THEN
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (
      p_owner,
      'system',
      CASE WHEN v_lost = 1 THEN '1 tool may be lost' ELSE v_lost::text || ' tools may be lost' END,
      left('Not returned long after the due time: ' || v_names ||
           CASE WHEN v_lost > 3 THEN ' and ' || (v_lost - 3)::text || ' more' ELSE '' END ||
           '. Confirm with the technician or mark the tool lost.', 500),
      '/dashboard/tools?tab=alerts'
    );
  END IF;

  -- Stage 1: overdue
  v_names := NULL;
  WITH hit AS (
    UPDATE tool_crib_loans l
    SET overdue_alerted_at = now(),
        updated_at = now()
    WHERE l.user_id = p_owner
      AND l.status = 'out'
      AND l.overdue_alerted_at IS NULL
      AND l.due_at < now()
    RETURNING l.id, l.tool_id, l.tool_name, l.technician_name
  ), ev AS (
    INSERT INTO tool_crib_events (user_id, tool_id, loan_id, event_type, actor_name, note)
    SELECT p_owner, h.tool_id, h.id, 'overdue_alert', 'System', h.technician_name FROM hit h
    RETURNING 1
  )
  SELECT count(*)::integer,
         array_to_string((array_agg(h.tool_name || ' (' || h.technician_name || ')' ORDER BY h.tool_name))[1:3], ', ')
  INTO v_over, v_names
  FROM hit h;

  IF v_over > 0 THEN
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (
      p_owner,
      'system',
      CASE WHEN v_over = 1 THEN '1 tool is overdue' ELSE v_over::text || ' tools are overdue' END,
      left('Past the return time: ' || v_names ||
           CASE WHEN v_over > 3 THEN ' and ' || (v_over - 3)::text || ' more' ELSE '' END ||
           '.', 500),
      '/dashboard/tools?tab=alerts'
    );
  END IF;

  RETURN jsonb_build_object('overdue', v_over, 'suspected_lost', v_lost);
END;
$$;

-- =============================================================
-- RPC: tool_crib_options — pickers, caller capabilities, settings
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
-- RPC: save_crib_tool — create or edit (manager)
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_crib_tool(
  p_tool_id uuid,
  p_tool_number text,
  p_name text,
  p_category text DEFAULT NULL,
  p_serial text DEFAULT NULL,
  p_barcode text DEFAULT NULL,
  p_cost_cents integer DEFAULT NULL,
  p_loan_hours integer DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_number text := btrim(COALESCE(p_tool_number, ''));
  v_name text := btrim(COALESCE(p_name, ''));
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.tool_crib_perm('can_manage_team') THEN
    RAISE EXCEPTION 'You do not have permission to manage the tool crib' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_number) < 1 OR char_length(v_number) > 40 THEN
    RAISE EXCEPTION 'Give the tool a tag number (max 40 characters)';
  END IF;
  IF char_length(v_name) < 1 OR char_length(v_name) > 120 THEN
    RAISE EXCEPTION 'Give the tool a name (max 120 characters)';
  END IF;
  IF p_cost_cents IS NOT NULL AND (p_cost_cents < 0 OR p_cost_cents > 100000000) THEN
    RAISE EXCEPTION 'Purchase cost must be between 0 and 1,000,000';
  END IF;
  IF p_loan_hours IS NOT NULL AND (p_loan_hours < 1 OR p_loan_hours > 720) THEN
    RAISE EXCEPTION 'Loan length must be between 1 and 720 hours';
  END IF;

  IF p_tool_id IS NULL THEN
    BEGIN
      INSERT INTO tool_crib_items (
        user_id, tool_number, name, category, serial_number, barcode,
        purchase_cost_cents, default_loan_hours, notes, created_by
      )
      VALUES (
        v_owner, v_number, v_name,
        NULLIF(left(btrim(COALESCE(p_category, '')), 60), ''),
        NULLIF(left(btrim(COALESCE(p_serial, '')), 80), ''),
        NULLIF(left(btrim(COALESCE(p_barcode, '')), 128), ''),
        p_cost_cents, p_loan_hours,
        NULLIF(left(btrim(COALESCE(p_notes, '')), 1000), ''),
        auth.uid()
      )
      RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Another tool already uses that tag number or barcode';
    END;
    PERFORM public.tool_crib_log(v_owner, v_id, NULL, 'created', v_name);
  ELSE
    BEGIN
      UPDATE tool_crib_items i
      SET tool_number = v_number,
          name = v_name,
          category = NULLIF(left(btrim(COALESCE(p_category, '')), 60), ''),
          serial_number = NULLIF(left(btrim(COALESCE(p_serial, '')), 80), ''),
          barcode = NULLIF(left(btrim(COALESCE(p_barcode, '')), 128), ''),
          purchase_cost_cents = p_cost_cents,
          default_loan_hours = p_loan_hours,
          notes = NULLIF(left(btrim(COALESCE(p_notes, '')), 1000), ''),
          updated_at = now()
      WHERE i.id = p_tool_id AND i.user_id = v_owner
      RETURNING i.id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Another tool already uses that tag number or barcode';
    END;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'Tool not found' USING ERRCODE = 'P0002';
    END IF;
    PERFORM public.tool_crib_log(v_owner, v_id, NULL, 'updated', v_name);
  END IF;

  RETURN v_id;
END;
$$;

-- =============================================================
-- RPC: check_out_crib_tool
-- =============================================================

CREATE OR REPLACE FUNCTION public.check_out_crib_tool(
  p_tool_id uuid,
  p_technician_id uuid,
  p_loan_hours integer DEFAULT NULL,
  p_condition text DEFAULT 'good',
  p_note text DEFAULT NULL
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
  v_set record;
  v_cond text := COALESCE(p_condition, 'good');
  v_hours integer;
  v_due timestamptz;
  v_loan_id uuid;
  v_tech_name text;
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

  SELECT * INTO v_set FROM public.tool_crib_settings_for(v_owner);
  v_hours := COALESCE(p_loan_hours, v_tool.default_loan_hours, v_set.loan_hours);
  v_due := now() + make_interval(hours => v_hours);
  v_tech_name := COALESCE(NULLIF(btrim(v_tm.member_name), ''), v_tm.member_email);

  INSERT INTO tool_crib_loans (
    user_id, tool_id, tool_name, tool_number, technician_id, technician_name,
    checked_out_by, due_at, out_condition, out_note
  )
  VALUES (
    v_owner, v_tool.id, v_tool.name, v_tool.tool_number, v_tm.id, v_tech_name,
    auth.uid(), v_due, v_cond,
    NULLIF(left(btrim(COALESCE(p_note, '')), 500), '')
  )
  RETURNING id INTO v_loan_id;

  UPDATE tool_crib_items SET status = 'checked_out', updated_at = now() WHERE id = v_tool.id;

  PERFORM public.tool_crib_log(
    v_owner, v_tool.id, v_loan_id, 'checked_out',
    'Taken by ' || v_tech_name || ', due ' || to_char(v_due AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC'
  );

  RETURN jsonb_build_object(
    'loan_id', v_loan_id,
    'tool_name', v_tool.name,
    'technician_name', v_tech_name,
    'due_at', v_due
  );
END;
$$;

-- =============================================================
-- RPC: check_in_crib_tool
-- =============================================================

CREATE OR REPLACE FUNCTION public.check_in_crib_tool(
  p_loan_id uuid,
  p_condition text DEFAULT 'good',
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tool_id uuid;
  v_loan tool_crib_loans%ROWTYPE;
  v_cond text := COALESCE(p_condition, 'good');
  v_new_status text;
  v_late boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF v_cond NOT IN ('good', 'worn', 'damaged') THEN
    RAISE EXCEPTION 'Condition must be good, worn or damaged';
  END IF;

  -- Lock order is always item first, then loan (matches check-out).
  SELECT l.tool_id INTO v_tool_id
  FROM tool_crib_loans l
  WHERE l.id = p_loan_id AND l.user_id = v_owner;
  IF v_tool_id IS NULL THEN
    RAISE EXCEPTION 'Loan not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1 FROM tool_crib_items i WHERE i.id = v_tool_id FOR UPDATE;

  SELECT * INTO v_loan
  FROM tool_crib_loans l
  WHERE l.id = p_loan_id AND l.user_id = v_owner
  FOR UPDATE;

  IF v_loan.status <> 'out' THEN
    RAISE EXCEPTION 'This tool is not checked out' USING ERRCODE = 'P0004';
  END IF;
  IF public.tool_crib_is_self_only()
     AND v_loan.technician_id IS DISTINCT FROM public.tool_crib_own_member_id() THEN
    RAISE EXCEPTION 'You can only return tools checked out to you' USING ERRCODE = '42501';
  END IF;

  v_late := v_loan.due_at < now();
  v_new_status := CASE WHEN v_cond = 'damaged' THEN 'maintenance' ELSE 'available' END;

  UPDATE tool_crib_loans
  SET status = 'returned',
      returned_at = now(),
      returned_by = auth.uid(),
      return_condition = v_cond,
      return_note = NULLIF(left(btrim(COALESCE(p_note, '')), 500), ''),
      updated_at = now()
  WHERE id = v_loan.id;

  UPDATE tool_crib_items SET status = v_new_status, updated_at = now() WHERE id = v_loan.tool_id;

  PERFORM public.tool_crib_log(
    v_owner, v_loan.tool_id, v_loan.id, 'checked_in',
    'Returned by ' || v_loan.technician_name || ' (' || v_cond || ')' ||
      CASE WHEN v_late THEN ', late' ELSE '' END ||
      CASE WHEN NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN '' ELSE ': ' || btrim(p_note) END
  );

  RETURN jsonb_build_object('was_late', v_late, 'tool_status', v_new_status);
END;
$$;

-- =============================================================
-- RPC: extend_crib_loan — more time, clears the alert stamps
-- =============================================================

CREATE OR REPLACE FUNCTION public.extend_crib_loan(
  p_loan_id uuid,
  p_extra_hours integer,
  p_note text DEFAULT NULL
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tool_id uuid;
  v_loan tool_crib_loans%ROWTYPE;
  v_due timestamptz;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_extra_hours IS NULL OR p_extra_hours < 1 OR p_extra_hours > 168 THEN
    RAISE EXCEPTION 'Extend by between 1 and 168 hours';
  END IF;

  SELECT l.tool_id INTO v_tool_id
  FROM tool_crib_loans l
  WHERE l.id = p_loan_id AND l.user_id = v_owner;
  IF v_tool_id IS NULL THEN
    RAISE EXCEPTION 'Loan not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1 FROM tool_crib_items i WHERE i.id = v_tool_id FOR UPDATE;

  SELECT * INTO v_loan
  FROM tool_crib_loans l
  WHERE l.id = p_loan_id AND l.user_id = v_owner
  FOR UPDATE;

  IF v_loan.status <> 'out' THEN
    RAISE EXCEPTION 'Only a tool that is checked out can be extended' USING ERRCODE = 'P0004';
  END IF;
  IF public.tool_crib_is_self_only()
     AND v_loan.technician_id IS DISTINCT FROM public.tool_crib_own_member_id() THEN
    RAISE EXCEPTION 'You can only extend tools checked out to you' USING ERRCODE = '42501';
  END IF;

  v_due := GREATEST(v_loan.due_at, now()) + make_interval(hours => p_extra_hours);

  UPDATE tool_crib_loans
  SET due_at = v_due,
      extended_count = extended_count + 1,
      overdue_alerted_at = NULL,
      lost_alerted_at = NULL,
      updated_at = now()
  WHERE id = v_loan.id;

  PERFORM public.tool_crib_log(
    v_owner, v_loan.tool_id, v_loan.id, 'extended',
    '+' || p_extra_hours::text || ' h, now due ' || to_char(v_due AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC' ||
      CASE WHEN NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN '' ELSE ': ' || btrim(p_note) END
  );

  RETURN v_due;
END;
$$;

-- =============================================================
-- RPC: mark_crib_tool_lost (manager)
-- =============================================================

CREATE OR REPLACE FUNCTION public.mark_crib_tool_lost(
  p_tool_id uuid,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tool tool_crib_items%ROWTYPE;
  v_loan_id uuid;
  v_note text := NULLIF(left(btrim(COALESCE(p_note, '')), 500), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.tool_crib_perm('can_manage_team') THEN
    RAISE EXCEPTION 'You do not have permission to mark tools lost' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_tool
  FROM tool_crib_items i
  WHERE i.id = p_tool_id AND i.user_id = v_owner
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tool not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_tool.status IN ('lost', 'retired') THEN
    RAISE EXCEPTION 'This tool is already %', v_tool.status USING ERRCODE = 'P0004';
  END IF;

  UPDATE tool_crib_loans
  SET status = 'lost', lost_at = now(), lost_note = v_note, updated_at = now()
  WHERE tool_id = v_tool.id AND status = 'out'
  RETURNING id INTO v_loan_id;

  UPDATE tool_crib_items SET status = 'lost', updated_at = now() WHERE id = v_tool.id;

  PERFORM public.tool_crib_log(v_owner, v_tool.id, v_loan_id, 'marked_lost', v_note);
END;
$$;

-- =============================================================
-- RPC: recover_crib_tool (manager) — a lost tool turned up
-- =============================================================

CREATE OR REPLACE FUNCTION public.recover_crib_tool(
  p_tool_id uuid,
  p_condition text DEFAULT 'good',
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tool tool_crib_items%ROWTYPE;
  v_cond text := COALESCE(p_condition, 'good');
  v_loan_id uuid;
  v_note text := NULLIF(left(btrim(COALESCE(p_note, '')), 500), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.tool_crib_perm('can_manage_team') THEN
    RAISE EXCEPTION 'You do not have permission to recover tools' USING ERRCODE = '42501';
  END IF;
  IF v_cond NOT IN ('good', 'worn', 'damaged') THEN
    RAISE EXCEPTION 'Condition must be good, worn or damaged';
  END IF;

  SELECT * INTO v_tool
  FROM tool_crib_items i
  WHERE i.id = p_tool_id AND i.user_id = v_owner
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tool not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_tool.status <> 'lost' THEN
    RAISE EXCEPTION 'Only a tool marked lost can be recovered' USING ERRCODE = 'P0004';
  END IF;

  UPDATE tool_crib_loans
  SET status = 'returned',
      returned_at = now(),
      returned_by = auth.uid(),
      return_condition = v_cond,
      return_note = COALESCE(v_note, 'Recovered after being reported lost'),
      updated_at = now()
  WHERE tool_id = v_tool.id AND status = 'lost'
  RETURNING id INTO v_loan_id;

  UPDATE tool_crib_items
  SET status = CASE WHEN v_cond = 'damaged' THEN 'maintenance' ELSE 'available' END,
      updated_at = now()
  WHERE id = v_tool.id;

  PERFORM public.tool_crib_log(v_owner, v_tool.id, v_loan_id, 'recovered', v_note);
END;
$$;

-- =============================================================
-- RPC: set_crib_tool_status (manager) — maintenance / retire / reinstate
-- =============================================================

CREATE OR REPLACE FUNCTION public.set_crib_tool_status(
  p_tool_id uuid,
  p_status text,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tool tool_crib_items%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.tool_crib_perm('can_manage_team') THEN
    RAISE EXCEPTION 'You do not have permission to manage the tool crib' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('available', 'maintenance', 'retired') THEN
    RAISE EXCEPTION 'Status must be available, maintenance or retired';
  END IF;

  SELECT * INTO v_tool
  FROM tool_crib_items i
  WHERE i.id = p_tool_id AND i.user_id = v_owner
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tool not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_tool.status IN ('checked_out', 'lost') THEN
    RAISE EXCEPTION 'Return or recover this tool before changing its status' USING ERRCODE = 'P0004';
  END IF;

  UPDATE tool_crib_items SET status = p_status, updated_at = now() WHERE id = v_tool.id;

  PERFORM public.tool_crib_log(
    v_owner, v_tool.id, NULL, 'status_changed',
    v_tool.status || ' -> ' || p_status ||
      CASE WHEN NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN '' ELSE ': ' || btrim(p_note) END
  );
END;
$$;

-- =============================================================
-- RPC: save_crib_settings (manager)
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_crib_settings(
  p_default_loan_hours integer,
  p_lost_after_hours integer,
  p_alerts_enabled boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.tool_crib_perm('can_manage_team') THEN
    RAISE EXCEPTION 'You do not have permission to change crib settings' USING ERRCODE = '42501';
  END IF;
  IF p_default_loan_hours IS NULL OR p_default_loan_hours < 1 OR p_default_loan_hours > 720 THEN
    RAISE EXCEPTION 'Default loan length must be between 1 and 720 hours';
  END IF;
  IF p_lost_after_hours IS NULL OR p_lost_after_hours < 1 OR p_lost_after_hours > 2160 THEN
    RAISE EXCEPTION 'Lost threshold must be between 1 and 2160 hours';
  END IF;

  INSERT INTO tool_crib_settings (user_id, default_loan_hours, lost_after_hours, alerts_enabled, updated_at)
  VALUES (v_owner, p_default_loan_hours, p_lost_after_hours, COALESCE(p_alerts_enabled, true), now())
  ON CONFLICT (user_id) DO UPDATE
    SET default_loan_hours = EXCLUDED.default_loan_hours,
        lost_after_hours = EXCLUDED.lost_after_hours,
        alerts_enabled = EXCLUDED.alerts_enabled,
        updated_at = now();
END;
$$;

-- =============================================================
-- RPC: scan_crib_tool_alerts — page calls this; safe to call often
-- =============================================================

CREATE OR REPLACE FUNCTION public.scan_crib_tool_alerts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN public.tool_crib_scan_owner(v_owner);
END;
$$;

-- Every account in one pass — for pg_cron / a scheduled edge function (service role only).
CREATE OR REPLACE FUNCTION public.scan_all_crib_tool_alerts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_n integer := 0;
BEGIN
  FOR v_owner IN
    SELECT DISTINCT l.user_id
    FROM tool_crib_loans l
    WHERE l.status = 'out' AND l.due_at < now()
  LOOP
    PERFORM public.tool_crib_scan_owner(v_owner);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

-- =============================================================
-- GRANTS — authenticated only; helpers and the all-accounts scan stay internal
-- =============================================================

REVOKE ALL ON FUNCTION public.tool_crib_perm(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tool_crib_actor_name() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tool_crib_own_member_id() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tool_crib_is_self_only() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tool_crib_settings_for(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tool_crib_log(uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tool_crib_scan_owner(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scan_all_crib_tool_alerts() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.tool_crib_options() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_crib_tool(uuid, text, text, text, text, text, integer, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.check_out_crib_tool(uuid, uuid, integer, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.check_in_crib_tool(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.extend_crib_loan(uuid, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_crib_tool_lost(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.recover_crib_tool(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_crib_tool_status(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_crib_settings(integer, integer, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.scan_crib_tool_alerts() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.tool_crib_options() TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_crib_tool(uuid, text, text, text, text, text, integer, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_out_crib_tool(uuid, uuid, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_in_crib_tool(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.extend_crib_loan(uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_crib_tool_lost(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recover_crib_tool(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_crib_tool_status(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_crib_settings(integer, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.scan_crib_tool_alerts() TO authenticated;

COMMENT ON TABLE tool_crib_items IS
  'Shared tools (tool crib). Read-only to account members; written only via the *_crib_* RPCs.';
COMMENT ON TABLE tool_crib_loans IS
  'One row per check-out. A tool has at most one open (status=out) loan. Written only via RPCs.';
COMMENT ON TABLE tool_crib_events IS
  'Audit timeline for the tool crib (checked out/in, extended, lost, alerts).';
COMMENT ON TABLE tool_crib_settings IS
  'Per-account tool crib defaults. No RLS policy on purpose: RPC-only access.';

/*
  Optional: run the alert scan for every account every 15 minutes (only if
  pg_cron is enabled on this project; the page already scans while open):

    SELECT cron.schedule('tool-crib-alerts', '*/15 * * * *', 'SELECT public.scan_all_crib_tool_alerts()');
*/
