/*
  # Inventory cycle counts & stocktake

  Physical counts against the existing inventory ledger. A count freezes a
  snapshot of expected quantities for one location, lets people scan/enter
  what is actually on the shelf, produces a variance report, and — only after
  a manager approves — posts the differences as 'adjustment' rows in the
  append-only inventory_transactions ledger (the existing trigger keeps
  inventory_stock_levels in sync, so nothing here writes stock directly).

  ## Tables
  - inventory_counts         — one row per count (header, status, totals)
  - inventory_count_lines    — per part: expected snapshot, counted qty,
                               unit-cost snapshot, applied adjustment
  - inventory_count_events   — audit timeline (started / submitted /
                               returned / approved / cancelled)

  ## Security model
  - Account scoping: every row carries user_id = the ACCOUNT OWNER's id,
    resolved with public.get_account_owner_id(), so owners and team members
    share the same counts.
  - No direct INSERT/UPDATE/DELETE policies: every write goes through the
    SECURITY DEFINER RPCs below, which re-check account membership and
    status. inventory_count_lines has NO policy at all (RPC-only) so that
    blind counts can really hide expected quantities and costs.
  - Approve / return / cancel-others require can_manage_team (owner always;
    custom-role permissions override team_members.permissions, matching
    AuthContext).
  - Unit costs are only returned to owner / can_view_billing.

  ## Adjustment rule
  delta = counted_qty - expected_qty (the frozen snapshot), applied on top of
  the CURRENT ledger balance. Receipts/usage posted while counting are kept.
  A part can be in only one open count per location (count lock), so the
  same variance can never be posted twice.
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS inventory_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  count_number text NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  count_type text NOT NULL DEFAULT 'cycle' CHECK (count_type IN ('cycle', 'full')),
  scope text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'category', 'selected', 'top_value')),
  scope_detail text,
  location_id uuid NOT NULL REFERENCES inventory_locations(id),
  location_name text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'pending_approval', 'approved', 'cancelled')),
  blind boolean NOT NULL DEFAULT false,
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text,
  submitted_at timestamptz,
  submitted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approval_note text,
  return_note text,
  line_count integer NOT NULL DEFAULT 0,
  counted_count integer NOT NULL DEFAULT 0,
  -- Variance totals stay NULL while status = 'in_progress' (blind counts).
  variance_line_count integer,
  net_variance_units integer,
  net_variance_value_cents bigint,
  gross_variance_value_cents bigint,
  accuracy_pct numeric(5, 2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, count_number)
);

CREATE INDEX IF NOT EXISTS idx_inventory_counts_user_status
  ON inventory_counts(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_counts_location
  ON inventory_counts(location_id);

CREATE TABLE IF NOT EXISTS inventory_count_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  count_id uuid NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  part_id uuid NOT NULL REFERENCES inventory_parts(id),
  part_name text NOT NULL,
  part_number text,
  category text,
  expected_qty integer NOT NULL,
  counted_qty integer CHECK (counted_qty IS NULL OR counted_qty >= 0),
  unit_cost_cents integer NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  note text,
  counted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  counted_at timestamptz,
  added_during_count boolean NOT NULL DEFAULT false,
  adjustment_transaction_id uuid REFERENCES inventory_transactions(id) ON DELETE SET NULL,
  applied_delta integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (count_id, part_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_count_lines_count ON inventory_count_lines(count_id);
CREATE INDEX IF NOT EXISTS idx_inventory_count_lines_part ON inventory_count_lines(user_id, part_id);

CREATE TABLE IF NOT EXISTS inventory_count_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  count_id uuid NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('started', 'submitted', 'returned', 'approved', 'cancelled')),
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_name text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_count_events_count
  ON inventory_count_events(count_id, created_at);

-- =============================================================
-- RLS — read-only for account members; all writes via RPC
-- =============================================================

ALTER TABLE inventory_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_count_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_count_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Account members view inventory counts" ON inventory_counts;
CREATE POLICY "Account members view inventory counts"
  ON inventory_counts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "Account members view inventory count events" ON inventory_count_events;
CREATE POLICY "Account members view inventory count events"
  ON inventory_count_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- inventory_count_lines intentionally has NO policy: it is only reachable
-- through get_inventory_count_lines(), which masks blind quantities / costs.

-- =============================================================
-- INTERNAL HELPERS
-- =============================================================

-- Owner => true. Team member => the (custom-role-overridden) permission flag.
CREATE OR REPLACE FUNCTION public.inventory_count_perm(p_key text)
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

CREATE OR REPLACE FUNCTION public.inventory_count_actor_name()
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

-- Recomputes progress + variance totals. Variance stays hidden (NULL) while
-- the count is in progress so blind counters cannot infer expected stock.
CREATE OR REPLACE FUNCTION public.inventory_count_recompute(p_count_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM inventory_counts WHERE id = p_count_id;

  UPDATE inventory_counts c
  SET line_count = s.total,
      counted_count = s.counted,
      variance_line_count = CASE WHEN v_status = 'in_progress' THEN NULL ELSE s.var_lines END,
      net_variance_units = CASE WHEN v_status = 'in_progress' THEN NULL ELSE s.net_units END,
      net_variance_value_cents = CASE WHEN v_status = 'in_progress' THEN NULL ELSE s.net_value END,
      gross_variance_value_cents = CASE WHEN v_status = 'in_progress' THEN NULL ELSE s.gross_value END,
      accuracy_pct = CASE
        WHEN v_status = 'in_progress' OR s.counted = 0 THEN NULL
        ELSE round(100.0 * s.exact / s.counted, 2)
      END,
      updated_at = now()
  FROM (
    SELECT
      count(*)::integer AS total,
      count(l.counted_qty)::integer AS counted,
      (count(*) FILTER (WHERE l.counted_qty IS NOT NULL AND l.counted_qty <> l.expected_qty))::integer AS var_lines,
      (count(*) FILTER (WHERE l.counted_qty IS NOT NULL AND l.counted_qty = l.expected_qty))::integer AS exact,
      COALESCE(sum(l.counted_qty - l.expected_qty) FILTER (WHERE l.counted_qty IS NOT NULL), 0)::integer AS net_units,
      COALESCE(sum((l.counted_qty - l.expected_qty)::bigint * l.unit_cost_cents) FILTER (WHERE l.counted_qty IS NOT NULL), 0)::bigint AS net_value,
      COALESCE(sum(abs(l.counted_qty - l.expected_qty)::bigint * l.unit_cost_cents) FILTER (WHERE l.counted_qty IS NOT NULL), 0)::bigint AS gross_value
    FROM inventory_count_lines l
    WHERE l.count_id = p_count_id
  ) s
  WHERE c.id = p_count_id;
END;
$$;

-- =============================================================
-- RPC: inventory_count_options — pickers for the "start a count" form
-- =============================================================

CREATE OR REPLACE FUNCTION public.inventory_count_options()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'locations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'location_type', x.location_type) ORDER BY x.name)
      FROM inventory_locations x
      WHERE x.user_id = v_owner AND x.active
    ), '[]'::jsonb),
    'parts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', q.id, 'name', q.name, 'part_number', q.part_number, 'category', q.category) ORDER BY q.name)
      FROM (
        SELECT p.id, p.name, p.part_number, p.category
        FROM inventory_parts p
        WHERE p.user_id = v_owner AND p.active
        ORDER BY p.name
        LIMIT 2000
      ) q
    ), '[]'::jsonb),
    'categories', COALESCE((
      SELECT jsonb_agg(c.category ORDER BY c.category)
      FROM (
        SELECT DISTINCT p.category
        FROM inventory_parts p
        WHERE p.user_id = v_owner AND p.active AND p.category IS NOT NULL AND btrim(p.category) <> ''
      ) c
    ), '[]'::jsonb)
  );
END;
$$;

-- =============================================================
-- RPC: start_inventory_count
-- =============================================================

CREATE OR REPLACE FUNCTION public.start_inventory_count(
  p_location_id uuid,
  p_name text,
  p_count_type text DEFAULT 'cycle',
  p_scope text DEFAULT 'all',
  p_category text DEFAULT NULL,
  p_part_ids uuid[] DEFAULT NULL,
  p_top_n integer DEFAULT NULL,
  p_blind boolean DEFAULT false,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_actor text := public.inventory_count_actor_name();
  v_name text := btrim(COALESCE(p_name, ''));
  v_type text := COALESCE(p_count_type, 'cycle');
  v_scope text := COALESCE(p_scope, 'all');
  v_top integer := COALESCE(p_top_n, 20);
  v_loc_name text;
  v_count_id uuid;
  v_detail text;
  v_lines integer;
  v_skipped integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_name) < 1 OR char_length(v_name) > 120 THEN
    RAISE EXCEPTION 'Give the count a name (max 120 characters)';
  END IF;
  IF v_type NOT IN ('cycle', 'full') THEN
    RAISE EXCEPTION 'Unknown count type';
  END IF;
  IF v_type = 'full' THEN
    v_scope := 'all';
  END IF;
  IF v_scope NOT IN ('all', 'category', 'selected', 'top_value') THEN
    RAISE EXCEPTION 'Unknown count scope';
  END IF;
  IF v_scope = 'category' AND (p_category IS NULL OR btrim(p_category) = '') THEN
    RAISE EXCEPTION 'Choose a category to count';
  END IF;
  IF v_scope = 'selected' AND (p_part_ids IS NULL OR cardinality(p_part_ids) = 0 OR cardinality(p_part_ids) > 500) THEN
    RAISE EXCEPTION 'Select between 1 and 500 parts to count';
  END IF;
  IF v_scope = 'top_value' AND (v_top < 1 OR v_top > 200) THEN
    RAISE EXCEPTION 'Top-value count must be between 1 and 200 parts';
  END IF;

  SELECT l.name INTO v_loc_name
  FROM inventory_locations l
  WHERE l.id = p_location_id AND l.user_id = v_owner AND l.active;
  IF v_loc_name IS NULL THEN
    RAISE EXCEPTION 'Location not found or inactive';
  END IF;

  v_detail := CASE v_scope
    WHEN 'category' THEN btrim(p_category)
    WHEN 'selected' THEN cardinality(p_part_ids)::text || ' selected parts'
    WHEN 'top_value' THEN 'Top ' || v_top::text || ' by stock value'
    ELSE NULL
  END;

  INSERT INTO inventory_counts (
    user_id, count_number, name, count_type, scope, scope_detail,
    location_id, location_name, blind, notes, created_by, created_by_name
  )
  VALUES (
    v_owner,
    'CNT-' || to_char(now() AT TIME ZONE 'UTC', 'YYMMDD') || '-' ||
      upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
    v_name, v_type, v_scope, v_detail,
    p_location_id, v_loc_name, COALESCE(p_blind, false),
    NULLIF(left(btrim(COALESCE(p_notes, '')), 1000), ''),
    auth.uid(), v_actor
  )
  RETURNING id INTO v_count_id;

  WITH scoped AS (
    SELECT
      p.id AS part_id,
      p.name,
      p.part_number,
      p.category,
      p.unit_cost_cents,
      COALESCE(s.quantity_on_hand, 0) AS qty,
      EXISTS (
        SELECT 1
        FROM inventory_count_lines l2
        JOIN inventory_counts c2 ON c2.id = l2.count_id
        WHERE l2.part_id = p.id
          AND c2.location_id = p_location_id
          AND c2.status IN ('in_progress', 'pending_approval')
          AND c2.id <> v_count_id
      ) AS locked
    FROM inventory_parts p
    LEFT JOIN inventory_stock_levels s
      ON s.part_id = p.id AND s.location_id = p_location_id AND s.user_id = v_owner
    WHERE p.user_id = v_owner
      AND p.active
      AND (
        (v_scope = 'all' AND s.id IS NOT NULL)
        OR (v_scope = 'category' AND p.category = btrim(p_category))
        OR (v_scope = 'selected' AND p.id = ANY (p_part_ids))
        OR (v_scope = 'top_value' AND p.id IN (
              SELECT s2.part_id
              FROM inventory_stock_levels s2
              JOIN inventory_parts p2 ON p2.id = s2.part_id
              WHERE s2.user_id = v_owner
                AND s2.location_id = p_location_id
                AND s2.quantity_on_hand > 0
                AND p2.active
              ORDER BY (s2.quantity_on_hand::bigint * p2.unit_cost_cents) DESC, p2.name
              LIMIT v_top
        ))
      )
  ),
  ins AS (
    INSERT INTO inventory_count_lines (
      user_id, count_id, part_id, part_name, part_number, category, expected_qty, unit_cost_cents
    )
    SELECT v_owner, v_count_id, sc.part_id, sc.name, sc.part_number, sc.category, sc.qty, sc.unit_cost_cents
    FROM scoped sc
    WHERE NOT sc.locked
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ins)::integer,
         (SELECT count(*) FROM scoped WHERE locked)::integer
  INTO v_lines, v_skipped;

  IF v_lines = 0 THEN
    -- Rolls back the header insert too.
    RAISE EXCEPTION 'No countable parts matched this scope (parts already in another open count at this location are skipped)';
  END IF;

  INSERT INTO inventory_count_events (user_id, count_id, event_type, actor_id, actor_name)
  VALUES (v_owner, v_count_id, 'started', auth.uid(), v_actor);

  PERFORM public.inventory_count_recompute(v_count_id);

  RETURN jsonb_build_object('count_id', v_count_id, 'line_count', v_lines, 'skipped_locked', v_skipped);
END;
$$;

-- =============================================================
-- RPC: get_inventory_count_lines — masked read
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_inventory_count_lines(p_count_id uuid)
RETURNS TABLE (
  line_id uuid,
  part_id uuid,
  part_name text,
  part_number text,
  category text,
  expected_qty integer,
  counted_qty integer,
  variance_qty integer,
  unit_cost_cents integer,
  variance_value_cents bigint,
  note text,
  counted_at timestamptz,
  added_during_count boolean,
  applied_delta integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_status text;
  v_blind boolean;
  v_hide_expected boolean;
  v_costs boolean := public.inventory_count_perm('can_view_billing');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT c.status, c.blind INTO v_status, v_blind
  FROM inventory_counts c
  WHERE c.id = p_count_id AND c.user_id = v_owner;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Count not found' USING ERRCODE = 'P0002';
  END IF;

  v_hide_expected := v_blind AND v_status = 'in_progress' AND NOT public.inventory_count_perm('can_manage_team');

  RETURN QUERY
  SELECT
    l.id,
    l.part_id,
    l.part_name,
    l.part_number,
    l.category,
    CASE WHEN v_hide_expected THEN NULL ELSE l.expected_qty END,
    l.counted_qty,
    CASE WHEN v_hide_expected OR l.counted_qty IS NULL THEN NULL ELSE l.counted_qty - l.expected_qty END,
    CASE WHEN v_costs THEN l.unit_cost_cents ELSE NULL END,
    CASE WHEN v_hide_expected OR NOT v_costs OR l.counted_qty IS NULL THEN NULL
         ELSE (l.counted_qty - l.expected_qty)::bigint * l.unit_cost_cents END,
    l.note,
    l.counted_at,
    l.added_during_count,
    l.applied_delta
  FROM inventory_count_lines l
  WHERE l.count_id = p_count_id AND l.user_id = v_owner
  ORDER BY l.part_name, l.part_id;
END;
$$;

-- =============================================================
-- RPC: count_inventory_part — scan / +1 / -1 (atomic increment)
-- =============================================================

CREATE OR REPLACE FUNCTION public.count_inventory_part(
  p_count_id uuid,
  p_part_id uuid DEFAULT NULL,
  p_barcode text DEFAULT NULL,
  p_increment integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_count inventory_counts%ROWTYPE;
  v_code text := left(btrim(COALESCE(p_barcode, '')), 128);
  v_part inventory_parts%ROWTYPE;
  v_line_id uuid;
  v_qty integer;
  v_added boolean := false;
  v_on_hand integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_increment IS NULL OR p_increment = 0 OR p_increment < -1000 OR p_increment > 1000 THEN
    RAISE EXCEPTION 'Increment must be a non-zero whole number between -1000 and 1000';
  END IF;

  SELECT * INTO v_count
  FROM inventory_counts c
  WHERE c.id = p_count_id AND c.user_id = v_owner
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_count.status <> 'in_progress' THEN
    RAISE EXCEPTION 'This count is no longer open for counting' USING ERRCODE = 'P0004';
  END IF;

  IF p_part_id IS NOT NULL THEN
    SELECT * INTO v_part
    FROM inventory_parts p
    WHERE p.id = p_part_id AND p.user_id = v_owner AND p.active;
  ELSIF v_code <> '' THEN
    SELECT * INTO v_part
    FROM inventory_parts p
    WHERE p.user_id = v_owner AND p.active
      AND (p.barcode = v_code OR lower(p.part_number) = lower(v_code))
    ORDER BY (p.barcode = v_code) DESC NULLS LAST
    LIMIT 1;
  ELSE
    RAISE EXCEPTION 'Provide a part or a barcode';
  END IF;

  IF v_part.id IS NULL THEN
    RAISE EXCEPTION 'No part matches that code' USING ERRCODE = 'P0002';
  END IF;

  SELECT l.id INTO v_line_id
  FROM inventory_count_lines l
  WHERE l.count_id = p_count_id AND l.part_id = v_part.id;

  IF v_line_id IS NOT NULL THEN
    UPDATE inventory_count_lines l
    SET counted_qty = GREATEST(0, COALESCE(l.counted_qty, 0) + p_increment),
        counted_by = auth.uid(),
        counted_at = now()
    WHERE l.id = v_line_id
    RETURNING l.counted_qty INTO v_qty;
  ELSE
    IF p_increment < 0 THEN
      RAISE EXCEPTION 'This part is not on the count sheet yet';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM inventory_count_lines l2
      JOIN inventory_counts c2 ON c2.id = l2.count_id
      WHERE l2.part_id = v_part.id
        AND c2.location_id = v_count.location_id
        AND c2.status IN ('in_progress', 'pending_approval')
        AND c2.id <> p_count_id
    ) THEN
      RAISE EXCEPTION 'This part is already being counted in another open count at this location' USING ERRCODE = 'P0003';
    END IF;

    SELECT COALESCE(s.quantity_on_hand, 0) INTO v_on_hand
    FROM (SELECT 1) one
    LEFT JOIN inventory_stock_levels s
      ON s.part_id = v_part.id AND s.location_id = v_count.location_id AND s.user_id = v_owner;

    INSERT INTO inventory_count_lines (
      user_id, count_id, part_id, part_name, part_number, category,
      expected_qty, counted_qty, unit_cost_cents, counted_by, counted_at, added_during_count
    )
    VALUES (
      v_owner, p_count_id, v_part.id, v_part.name, v_part.part_number, v_part.category,
      COALESCE(v_on_hand, 0), p_increment, v_part.unit_cost_cents, auth.uid(), now(), true
    )
    ON CONFLICT (count_id, part_id) DO UPDATE
      SET counted_qty = GREATEST(0, COALESCE(inventory_count_lines.counted_qty, 0) + p_increment),
          counted_by = auth.uid(),
          counted_at = now()
    RETURNING id, counted_qty INTO v_line_id, v_qty;
    v_added := true;
  END IF;

  PERFORM public.inventory_count_recompute(p_count_id);

  RETURN jsonb_build_object(
    'line_id', v_line_id,
    'part_id', v_part.id,
    'part_name', v_part.name,
    'counted_qty', v_qty,
    'added', v_added
  );
END;
$$;

-- =============================================================
-- RPC: set_inventory_count_line — type an absolute quantity / clear it
-- =============================================================

CREATE OR REPLACE FUNCTION public.set_inventory_count_line(
  p_line_id uuid,
  p_counted_qty integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_count_id uuid;
  v_status text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_counted_qty IS NOT NULL AND (p_counted_qty < 0 OR p_counted_qty > 1000000) THEN
    RAISE EXCEPTION 'Counted quantity must be a whole number between 0 and 1,000,000';
  END IF;

  SELECT l.count_id INTO v_count_id
  FROM inventory_count_lines l
  WHERE l.id = p_line_id AND l.user_id = v_owner;
  IF v_count_id IS NULL THEN
    RAISE EXCEPTION 'Count line not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT c.status INTO v_status
  FROM inventory_counts c
  WHERE c.id = v_count_id
  FOR SHARE;
  IF v_status <> 'in_progress' THEN
    RAISE EXCEPTION 'This count is no longer open for counting' USING ERRCODE = 'P0004';
  END IF;

  UPDATE inventory_count_lines l
  SET counted_qty = p_counted_qty,
      counted_by = CASE WHEN p_counted_qty IS NULL THEN NULL ELSE auth.uid() END,
      counted_at = CASE WHEN p_counted_qty IS NULL THEN NULL ELSE now() END
  WHERE l.id = p_line_id;

  PERFORM public.inventory_count_recompute(v_count_id);
END;
$$;

-- =============================================================
-- RPC: set_inventory_count_line_note — explain a variance (never touches quantities)
-- =============================================================

CREATE OR REPLACE FUNCTION public.set_inventory_count_line_note(
  p_line_id uuid,
  p_note text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_count_id uuid;
  v_status text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT l.count_id INTO v_count_id
  FROM inventory_count_lines l
  WHERE l.id = p_line_id AND l.user_id = v_owner;
  IF v_count_id IS NULL THEN
    RAISE EXCEPTION 'Count line not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT c.status INTO v_status FROM inventory_counts c WHERE c.id = v_count_id FOR SHARE;
  IF v_status <> 'in_progress' THEN
    RAISE EXCEPTION 'This count is no longer open for counting' USING ERRCODE = 'P0004';
  END IF;

  UPDATE inventory_count_lines l
  SET note = NULLIF(left(btrim(COALESCE(p_note, '')), 500), '')
  WHERE l.id = p_line_id;
END;
$$;

-- =============================================================
-- RPC: submit_inventory_count
-- =============================================================

CREATE OR REPLACE FUNCTION public.submit_inventory_count(
  p_count_id uuid,
  p_allow_uncounted boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_count inventory_counts%ROWTYPE;
  v_uncounted integer;
  v_counted integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_count
  FROM inventory_counts c
  WHERE c.id = p_count_id AND c.user_id = v_owner
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_count.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Only a count in progress can be submitted' USING ERRCODE = 'P0004';
  END IF;

  SELECT count(*) FILTER (WHERE l.counted_qty IS NULL), count(*) FILTER (WHERE l.counted_qty IS NOT NULL)
  INTO v_uncounted, v_counted
  FROM inventory_count_lines l
  WHERE l.count_id = p_count_id;

  IF v_counted = 0 THEN
    RAISE EXCEPTION 'Count at least one part before submitting' USING ERRCODE = 'P0004';
  END IF;
  IF v_uncounted > 0 AND NOT COALESCE(p_allow_uncounted, false) THEN
    RAISE EXCEPTION '% line(s) have not been counted yet', v_uncounted USING ERRCODE = 'P0004';
  END IF;

  UPDATE inventory_counts
  SET status = 'pending_approval',
      submitted_at = now(),
      submitted_by = auth.uid(),
      return_note = NULL
  WHERE id = p_count_id;

  PERFORM public.inventory_count_recompute(p_count_id);

  INSERT INTO inventory_count_events (user_id, count_id, event_type, actor_id, actor_name)
  VALUES (v_owner, p_count_id, 'submitted', auth.uid(), public.inventory_count_actor_name());
END;
$$;

-- =============================================================
-- RPC: approve_inventory_count — posts adjustment transactions
-- =============================================================

CREATE OR REPLACE FUNCTION public.approve_inventory_count(
  p_count_id uuid,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_count inventory_counts%ROWTYPE;
  v_line inventory_count_lines%ROWTYPE;
  v_txn_id uuid;
  v_delta integer;
  v_adjusted integer := 0;
  v_net_units integer := 0;
  v_net_value bigint := 0;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.inventory_count_perm('can_manage_team') THEN
    RAISE EXCEPTION 'You do not have permission to approve inventory counts' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_count
  FROM inventory_counts c
  WHERE c.id = p_count_id AND c.user_id = v_owner
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_count.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'Only a submitted count can be approved' USING ERRCODE = 'P0004';
  END IF;

  FOR v_line IN
    SELECT *
    FROM inventory_count_lines l
    WHERE l.count_id = p_count_id
      AND l.counted_qty IS NOT NULL
      AND l.counted_qty <> l.expected_qty
    ORDER BY l.part_name
    FOR UPDATE
  LOOP
    v_delta := v_line.counted_qty - v_line.expected_qty;

    INSERT INTO inventory_transactions (
      user_id, part_id, location_id, transaction_type, quantity_delta, unit_cost_cents, note
    )
    VALUES (
      v_owner, v_line.part_id, v_count.location_id, 'adjustment', v_delta, v_line.unit_cost_cents,
      left(
        'Count ' || v_count.count_number || ' (' || v_count.name || '): counted ' ||
        v_line.counted_qty::text || ' vs expected ' || v_line.expected_qty::text,
        500
      )
    )
    RETURNING id INTO v_txn_id;

    UPDATE inventory_count_lines
    SET adjustment_transaction_id = v_txn_id,
        applied_delta = v_delta
    WHERE id = v_line.id;

    v_adjusted := v_adjusted + 1;
    v_net_units := v_net_units + v_delta;
    v_net_value := v_net_value + (v_delta::bigint * v_line.unit_cost_cents);
  END LOOP;

  UPDATE inventory_counts
  SET status = 'approved',
      approved_at = now(),
      approved_by = auth.uid(),
      approval_note = NULLIF(left(btrim(COALESCE(p_note, '')), 500), '')
  WHERE id = p_count_id;

  PERFORM public.inventory_count_recompute(p_count_id);

  INSERT INTO inventory_count_events (user_id, count_id, event_type, actor_id, actor_name, note)
  VALUES (v_owner, p_count_id, 'approved', auth.uid(), public.inventory_count_actor_name(),
          NULLIF(left(btrim(COALESCE(p_note, '')), 500), ''));

  RETURN jsonb_build_object(
    'adjusted_lines', v_adjusted,
    'net_units', v_net_units,
    'net_value_cents', v_net_value
  );
END;
$$;

-- =============================================================
-- RPC: return_inventory_count_for_recount
-- =============================================================

CREATE OR REPLACE FUNCTION public.return_inventory_count_for_recount(
  p_count_id uuid,
  p_note text,
  p_line_ids uuid[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_count inventory_counts%ROWTYPE;
  v_note text := NULLIF(left(btrim(COALESCE(p_note, '')), 500), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.inventory_count_perm('can_manage_team') THEN
    RAISE EXCEPTION 'You do not have permission to review inventory counts' USING ERRCODE = '42501';
  END IF;
  IF v_note IS NULL OR char_length(v_note) < 3 THEN
    RAISE EXCEPTION 'Add a short note explaining what to recount';
  END IF;

  SELECT * INTO v_count
  FROM inventory_counts c
  WHERE c.id = p_count_id AND c.user_id = v_owner
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_count.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'Only a submitted count can be returned' USING ERRCODE = 'P0004';
  END IF;

  IF p_line_ids IS NOT NULL AND cardinality(p_line_ids) > 0 THEN
    UPDATE inventory_count_lines l
    SET counted_qty = NULL, counted_by = NULL, counted_at = NULL
    WHERE l.count_id = p_count_id AND l.id = ANY (p_line_ids);
  END IF;

  UPDATE inventory_counts
  SET status = 'in_progress', return_note = v_note
  WHERE id = p_count_id;

  PERFORM public.inventory_count_recompute(p_count_id);

  INSERT INTO inventory_count_events (user_id, count_id, event_type, actor_id, actor_name, note)
  VALUES (v_owner, p_count_id, 'returned', auth.uid(), public.inventory_count_actor_name(), v_note);
END;
$$;

-- =============================================================
-- RPC: cancel_inventory_count — releases the count lock, posts nothing
-- =============================================================

CREATE OR REPLACE FUNCTION public.cancel_inventory_count(
  p_count_id uuid,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_count inventory_counts%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_count
  FROM inventory_counts c
  WHERE c.id = p_count_id AND c.user_id = v_owner
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_count.status NOT IN ('in_progress', 'pending_approval') THEN
    RAISE EXCEPTION 'This count can no longer be cancelled' USING ERRCODE = 'P0004';
  END IF;
  IF NOT public.inventory_count_perm('can_manage_team')
     AND NOT (v_count.created_by = auth.uid() AND v_count.status = 'in_progress') THEN
    RAISE EXCEPTION 'Only the person who started this count, or a manager, can cancel it' USING ERRCODE = '42501';
  END IF;

  UPDATE inventory_counts SET status = 'cancelled' WHERE id = p_count_id;
  PERFORM public.inventory_count_recompute(p_count_id);

  INSERT INTO inventory_count_events (user_id, count_id, event_type, actor_id, actor_name, note)
  VALUES (v_owner, p_count_id, 'cancelled', auth.uid(), public.inventory_count_actor_name(),
          NULLIF(left(btrim(COALESCE(p_note, '')), 500), ''));
END;
$$;

-- =============================================================
-- GRANTS — authenticated only; helpers stay internal
-- =============================================================

REVOKE ALL ON FUNCTION public.inventory_count_perm(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inventory_count_actor_name() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inventory_count_recompute(uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.inventory_count_options() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.start_inventory_count(uuid, text, text, text, text, uuid[], integer, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_inventory_count_lines(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.count_inventory_part(uuid, uuid, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_inventory_count_line(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_inventory_count_line_note(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.submit_inventory_count(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_inventory_count(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.return_inventory_count_for_recount(uuid, text, uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_inventory_count(uuid, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.inventory_count_options() TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_inventory_count(uuid, text, text, text, text, uuid[], integer, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_inventory_count_lines(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_inventory_part(uuid, uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_inventory_count_line(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_inventory_count_line_note(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_inventory_count(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_inventory_count(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.return_inventory_count_for_recount(uuid, text, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_inventory_count(uuid, text) TO authenticated;

COMMENT ON TABLE inventory_counts IS
  'Cycle counts / stocktakes. Read-only to account members; written only via the *_inventory_count RPCs. Approval posts adjustment rows to inventory_transactions.';
COMMENT ON TABLE inventory_count_lines IS
  'Per-part expected snapshot + counted quantity. No RLS policy on purpose: access only through get_inventory_count_lines() so blind counts and costs are masked server-side.';
