/*
  # Vireek Service Graph (Vireek Intelligence Graph) — schema-tolerant edition

  Persistent graph: Customer -> Property -> Equipment -> Failure -> Technician
  -> Part -> Job -> Outcome -> Warranty -> Future Failure (callback).

  - service_graph_nodes / service_graph_edges : read-only for clients (RLS).
  - All writes happen through SECURITY DEFINER functions and triggers.
  - Triggers never block core operations: errors become WARNINGs.
  - No invoice amounts are stored in the graph (billing data stays gated).

  ## Why this edition exists
  The first version failed with:
    column "customer_type" of relation "customers" does not exist
  because it hard-coded optional columns (and `UPDATE OF <column list>`
  triggers, which Postgres validates at CREATE time). This version:
    - reads every drift-prone table through to_jsonb(row)->>'column', so a
      missing column becomes NULL instead of an error;
    - wraps each optional section (customer, call, parts, equipment,
      callbacks, warranty) so a missing table/column only skips that
      section, never the whole job sync;
    - installs each trigger only if its table exists, with no column lists;
    - is fully idempotent: safe to re-run from the top at any time.
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS service_graph_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  node_type text NOT NULL CHECK (node_type IN (
    'customer', 'property', 'equipment', 'failure', 'technician', 'part', 'job',
    'outcome', 'warranty', 'vendor', 'call', 'payment', 'contractor', 'knowledge', 'agent'
  )),
  node_key text NOT NULL,
  label text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, node_type, node_key)
);

CREATE INDEX IF NOT EXISTS idx_sg_nodes_user_type ON service_graph_nodes(user_id, node_type);
CREATE INDEX IF NOT EXISTS idx_sg_nodes_user_updated ON service_graph_nodes(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS service_graph_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  from_node uuid NOT NULL REFERENCES service_graph_nodes(id) ON DELETE CASCADE,
  to_node uuid NOT NULL REFERENCES service_graph_nodes(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation ~ '^[a-z_]{2,40}$'),
  source text NOT NULL DEFAULT 'system' CHECK (source IN ('system', 'staff', 'ai')),
  weight numeric(6, 3) NOT NULL DEFAULT 1 CHECK (weight >= 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, from_node, to_node, relation),
  CHECK (from_node <> to_node)
);

CREATE INDEX IF NOT EXISTS idx_sg_edges_user_to ON service_graph_edges(user_id, to_node, relation);
CREATE INDEX IF NOT EXISTS idx_sg_edges_user_relation ON service_graph_edges(user_id, relation);
CREATE INDEX IF NOT EXISTS idx_sg_edges_user_from ON service_graph_edges(user_id, from_node, relation);

ALTER TABLE service_graph_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_graph_edges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_service_graph_nodes" ON service_graph_nodes;
CREATE POLICY "select_own_service_graph_nodes" ON service_graph_nodes
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_service_graph_edges" ON service_graph_edges;
CREATE POLICY "select_own_service_graph_edges" ON service_graph_edges
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- INTERNAL HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public._sg_norm_address(p_addr text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(left(lower(regexp_replace(btrim(COALESCE(p_addr, '')), '\s+', ' ', 'g')), 300), '');
$$;

-- Safe date cast: bad/missing values become NULL instead of raising.
CREATE OR REPLACE FUNCTION public._sg_date(p_text text)
RETURNS date LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN NULLIF(btrim(COALESCE(p_text, '')), '')::date;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public._sg_find(p_user uuid, p_type text, p_key text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM service_graph_nodes
  WHERE user_id = p_user AND node_type = p_type AND node_key = p_key;
$$;

CREATE OR REPLACE FUNCTION public._sg_node(
  p_user uuid, p_type text, p_key text, p_label text, p_props jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO service_graph_nodes (user_id, node_type, node_key, label, properties)
  VALUES (
    p_user, p_type, p_key,
    left(COALESCE(NULLIF(btrim(p_label), ''), p_key), 200),
    COALESCE(p_props, '{}'::jsonb)
  )
  ON CONFLICT (user_id, node_type, node_key) DO UPDATE
    SET label = EXCLUDED.label,
        properties = service_graph_nodes.properties || EXCLUDED.properties,
        updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public._sg_edge(
  p_user uuid, p_from uuid, p_to uuid, p_relation text,
  p_source text DEFAULT 'system', p_evidence jsonb DEFAULT '{}'::jsonb
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from = p_to THEN
    RETURN;
  END IF;
  INSERT INTO service_graph_edges (user_id, from_node, to_node, relation, source, evidence)
  VALUES (p_user, p_from, p_to, p_relation, p_source, COALESCE(p_evidence, '{}'::jsonb))
  ON CONFLICT (user_id, from_node, to_node, relation) DO UPDATE
    SET last_seen_at = now(),
        evidence = service_graph_edges.evidence || EXCLUDED.evidence;
END;
$$;

-- Removes stale SYSTEM edges (staff/ai edges are never pruned).
CREATE OR REPLACE FUNCTION public._sg_prune(
  p_user uuid, p_node uuid, p_relation text, p_dir text, p_keep uuid[]
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_node IS NULL THEN
    RETURN;
  END IF;
  IF p_dir = 'out' THEN
    DELETE FROM service_graph_edges
    WHERE user_id = p_user AND from_node = p_node AND relation = p_relation AND source = 'system'
      AND NOT (to_node = ANY (COALESCE(p_keep, '{}'::uuid[])));
  ELSE
    DELETE FROM service_graph_edges
    WHERE user_id = p_user AND to_node = p_node AND relation = p_relation AND source = 'system'
      AND NOT (from_node = ANY (COALESCE(p_keep, '{}'::uuid[])));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._sg_tech_node(p_user uuid, p_member uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  tm jsonb;
BEGIN
  SELECT to_jsonb(t) INTO tm FROM team_members t
  WHERE t.id = p_member AND t.account_owner_id = p_user;
  IF tm IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN public._sg_node(
    p_user, 'technician', p_member::text,
    COALESCE(NULLIF(btrim(tm->>'member_name'), ''), NULLIF(btrim(tm->>'member_email'), ''), 'Technician'),
    jsonb_build_object('role', tm->>'role')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._sg_part_node(p_user uuid, p_part uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  pt jsonb;
  v_id uuid;
  v_vendor uuid;
  r record;
BEGIN
  SELECT to_jsonb(p) INTO pt FROM inventory_parts p WHERE p.id = p_part AND p.user_id = p_user;
  IF pt IS NULL THEN
    RETURN NULL;
  END IF;

  v_id := public._sg_node(
    p_user, 'part', p_part::text,
    COALESCE(NULLIF(btrim(pt->>'part_number'), '') || ' · ', '') || COALESCE(NULLIF(btrim(pt->>'name'), ''), 'Part'),
    jsonb_build_object('part_number', pt->>'part_number', 'name', pt->>'name', 'category', pt->>'category')
  );

  -- Vendors are optional (table added by a later migration): never block the part node.
  BEGIN
    FOR r IN
      SELECT vd.id, vd.name, pv.is_preferred, pv.lead_time_days
      FROM inventory_part_vendors pv
      JOIN inventory_vendors vd ON vd.id = pv.vendor_id
      WHERE pv.part_id = p_part AND pv.user_id = p_user AND vd.user_id = p_user
    LOOP
      v_vendor := public._sg_node(p_user, 'vendor', r.id::text, r.name, '{}'::jsonb);
      PERFORM public._sg_edge(
        p_user, v_id, v_vendor, 'supplied_by', 'system',
        jsonb_build_object('preferred', r.is_preferred, 'lead_time_days', r.lead_time_days)
      );
    END LOOP;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL;
  END;

  RETURN v_id;
END;
$$;

-- =============================================================
-- ENTITY SYNC (idempotent; safe to re-run)
-- =============================================================

CREATE OR REPLACE FUNCTION public._sg_sync_customer(p_customer_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cu jsonb;
  v_user uuid;
  v_cust uuid;
  v_prop uuid;
  v_addr text;
BEGIN
  SELECT to_jsonb(c) INTO cu FROM customers c WHERE c.id = p_customer_id;
  IF cu IS NULL THEN
    RETURN;
  END IF;
  v_user := (cu->>'user_id')::uuid;

  v_cust := public._sg_node(
    v_user, 'customer', p_customer_id::text,
    COALESCE(NULLIF(btrim(cu->>'name'), ''), 'Customer'),
    jsonb_build_object('customer_type', cu->>'customer_type', 'lifecycle_stage', cu->>'lifecycle_stage')
  );

  v_addr := public._sg_norm_address(cu->>'address');
  IF v_addr IS NOT NULL THEN
    v_prop := public._sg_node(v_user, 'property', v_addr, btrim(cu->>'address'), '{}'::jsonb);
    PERFORM public._sg_edge(v_user, v_cust, v_prop, 'has_property');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._sg_sync_equipment(p_equipment_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  eq jsonb;
  cu jsonb;
  v_user uuid;
  v_eq uuid;
  v_cust uuid;
  v_prop uuid;
  v_job uuid;
  v_war uuid;
  v_addr text;
  v_warranty date;
  v_keep uuid[] := '{}';
BEGIN
  SELECT to_jsonb(e) INTO eq FROM equipment e WHERE e.id = p_equipment_id;
  IF eq IS NULL THEN
    RETURN;
  END IF;
  v_user := (eq->>'user_id')::uuid;
  v_warranty := public._sg_date(eq->>'warranty_expires_at');

  v_eq := public._sg_node(
    v_user, 'equipment', p_equipment_id::text,
    COALESCE(NULLIF(concat_ws(' · ',
      NULLIF(btrim(eq->>'make'), ''), NULLIF(btrim(eq->>'model'), ''), NULLIF(btrim(eq->>'equipment_type'), '')), ''), 'Equipment'),
    jsonb_build_object(
      'type', eq->>'equipment_type', 'make', eq->>'make', 'model', eq->>'model',
      'install_date', eq->>'install_date', 'status', eq->>'status',
      'expected_lifespan_years', eq->>'expected_lifespan_years',
      'warranty_expires_at', eq->>'warranty_expires_at'
    )
  );

  IF NULLIF(eq->>'customer_id', '') IS NOT NULL THEN
    SELECT to_jsonb(c) INTO cu FROM customers c
    WHERE c.id = (eq->>'customer_id')::uuid AND c.user_id = v_user;
    IF cu IS NOT NULL THEN
      PERFORM public._sg_sync_customer((cu->>'id')::uuid);
      v_cust := public._sg_find(v_user, 'customer', cu->>'id');
      PERFORM public._sg_edge(v_user, v_cust, v_eq, 'owns_equipment');
      v_addr := public._sg_norm_address(cu->>'address');
      IF v_addr IS NOT NULL THEN
        v_prop := public._sg_find(v_user, 'property', v_addr);
        PERFORM public._sg_edge(v_user, v_prop, v_eq, 'has_equipment');
      END IF;
    END IF;
  END IF;

  IF NULLIF(eq->>'install_job_id', '') IS NOT NULL THEN
    v_job := public._sg_find(v_user, 'job', eq->>'install_job_id');
    IF v_job IS NOT NULL THEN
      PERFORM public._sg_edge(v_user, v_job, v_eq, 'installed');
    END IF;
  END IF;

  IF v_warranty IS NOT NULL THEN
    v_war := public._sg_node(
      v_user, 'warranty', 'eq:' || p_equipment_id::text,
      'Warranty until ' || to_char(v_warranty, 'YYYY-MM-DD'),
      jsonb_build_object('kind', 'equipment', 'expires_at', v_warranty)
    );
    PERFORM public._sg_edge(v_user, v_eq, v_war, 'covered_by');
    v_keep := ARRAY[v_war];
  END IF;
  PERFORM public._sg_prune(v_user, v_eq, 'covered_by', 'out', v_keep);
END;
$$;

CREATE OR REPLACE FUNCTION public._sg_sync_claim(p_claim_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  wc jsonb;
  v_user uuid;
  v_w uuid;
  v_job uuid;
  v_eq uuid;
BEGIN
  SELECT to_jsonb(w) INTO wc FROM warranty_claims w WHERE w.id = p_claim_id;
  IF wc IS NULL THEN
    RETURN;
  END IF;
  v_user := (wc->>'user_id')::uuid;

  v_w := public._sg_node(
    v_user, 'warranty', 'claim:' || p_claim_id::text,
    'Warranty claim · ' || replace(COALESCE(wc->>'status', 'open'), '_', ' '),
    jsonb_build_object('kind', 'claim', 'status', wc->>'status', 'manufacturer', wc->>'manufacturer')
  );

  IF NULLIF(wc->>'job_id', '') IS NOT NULL THEN
    v_job := public._sg_find(v_user, 'job', wc->>'job_id');
    IF v_job IS NOT NULL THEN
      PERFORM public._sg_edge(v_user, v_job, v_w, 'claimed_under');
    END IF;
  END IF;

  IF NULLIF(wc->>'equipment_id', '') IS NOT NULL
     AND EXISTS (SELECT 1 FROM equipment e WHERE e.id = (wc->>'equipment_id')::uuid AND e.user_id = v_user) THEN
    PERFORM public._sg_sync_equipment((wc->>'equipment_id')::uuid);
    v_eq := public._sg_find(v_user, 'equipment', wc->>'equipment_id');
    PERFORM public._sg_edge(v_user, v_eq, v_w, 'has_claim');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._sg_sync_job(p_job_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  jb jsonb;
  cu jsonb;
  r record;
  v_user uuid;
  v_job uuid; v_cust uuid; v_prop uuid; v_tech uuid; v_call uuid; v_pay uuid;
  v_part uuid; v_eq uuid; v_fail uuid; v_other uuid; v_claim uuid; v_out uuid;
  v_type text;
  v_addr text;
  v_status text;
  v_keep uuid[];
  v_used uuid[] := '{}';
  v_req uuid[] := '{}';
  v_eq_keep uuid[] := '{}';
  v_fail_keep uuid[] := '{}';
  v_cb_in uuid[] := '{}';
  v_cb_out uuid[] := '{}';
  v_has_callback boolean := false;
  v_has_claim boolean := false;
BEGIN
  SELECT to_jsonb(j) INTO jb FROM jobs j WHERE j.id = p_job_id;
  IF jb IS NULL THEN
    RETURN;
  END IF;
  v_user := (jb->>'user_id')::uuid;
  v_status := jb->>'job_status';

  v_job := public._sg_node(
    v_user, 'job', p_job_id::text,
    COALESCE(NULLIF(btrim(COALESCE(jb->>'service_type', '')), ''), 'Job') || ' · ' ||
      COALESCE(NULLIF(btrim(COALESCE(jb->>'customer_name', '')), ''), 'Customer'),
    jsonb_build_object(
      'status', v_status, 'service_type', jb->>'service_type',
      'scheduled_at', jb->>'scheduled_datetime', 'created_at', jb->>'created_at'
    )
  );

  -- Customer -> Job
  v_keep := '{}';
  BEGIN
    IF NULLIF(jb->>'customer_id', '') IS NOT NULL THEN
      SELECT to_jsonb(c) INTO cu FROM customers c
      WHERE c.id = (jb->>'customer_id')::uuid AND c.user_id = v_user;
      IF cu IS NOT NULL THEN
        PERFORM public._sg_sync_customer((cu->>'id')::uuid);
        v_cust := public._sg_find(v_user, 'customer', cu->>'id');
        PERFORM public._sg_edge(v_user, v_cust, v_job, 'requested');
        v_keep := ARRAY[v_cust];
      END IF;
    END IF;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL;
  END;
  PERFORM public._sg_prune(v_user, v_job, 'requested', 'in', v_keep);

  -- Job -> Property
  v_keep := '{}';
  v_addr := public._sg_norm_address(COALESCE(NULLIF(btrim(jb->>'address'), ''), cu->>'address'));
  IF v_addr IS NOT NULL THEN
    v_prop := public._sg_node(
      v_user, 'property', v_addr,
      btrim(COALESCE(NULLIF(btrim(jb->>'address'), ''), cu->>'address')), '{}'::jsonb
    );
    PERFORM public._sg_edge(v_user, v_job, v_prop, 'performed_at');
    IF v_cust IS NOT NULL THEN
      PERFORM public._sg_edge(v_user, v_cust, v_prop, 'has_property');
    END IF;
    v_keep := ARRAY[v_prop];
  END IF;
  PERFORM public._sg_prune(v_user, v_job, 'performed_at', 'out', v_keep);

  -- Job -> Technician
  v_keep := '{}';
  BEGIN
    IF NULLIF(jb->>'assigned_technician_id', '') IS NOT NULL THEN
      v_tech := public._sg_tech_node(v_user, (jb->>'assigned_technician_id')::uuid);
      IF v_tech IS NOT NULL THEN
        PERFORM public._sg_edge(v_user, v_job, v_tech, 'handled_by');
        v_keep := ARRAY[v_tech];
      END IF;
    END IF;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL;
  END;
  PERFORM public._sg_prune(v_user, v_job, 'handled_by', 'out', v_keep);

  -- Call -> Job
  v_keep := '{}';
  BEGIN
    IF NULLIF(jb->>'call_id', '') IS NOT NULL THEN
      SELECT c.id, to_jsonb(c)->>'call_datetime' AS call_at INTO r
      FROM calls c WHERE c.id = (jb->>'call_id')::uuid AND c.user_id = v_user;
      IF FOUND THEN
        v_call := public._sg_node(
          v_user, 'call', r.id::text,
          'Call · ' || COALESCE(left(r.call_at, 10), 'unknown date'), '{}'::jsonb
        );
        PERFORM public._sg_edge(v_user, v_call, v_job, 'originated');
        v_keep := ARRAY[v_call];
      END IF;
    END IF;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL;
  END;
  PERFORM public._sg_prune(v_user, v_job, 'originated', 'in', v_keep);

  -- Job -> Payment (status only, no amounts)
  v_keep := '{}';
  IF NULLIF(jb->>'invoice_amount', '') IS NOT NULL THEN
    v_pay := public._sg_node(
      v_user, 'payment', p_job_id::text,
      'Invoice · ' || replace(COALESCE(jb->>'invoice_status', 'not_sent'), '_', ' '),
      jsonb_build_object('status', jb->>'invoice_status')
    );
    PERFORM public._sg_edge(v_user, v_job, v_pay, 'billed_as');
    v_keep := ARRAY[v_pay];
  END IF;
  PERFORM public._sg_prune(v_user, v_job, 'billed_as', 'out', v_keep);

  -- Job -> Parts (optional module)
  BEGIN
    FOR r IN
      SELECT jr.part_id, to_jsonb(jr)->>'status' AS status, to_jsonb(jr)->>'quantity_required' AS qty
      FROM job_parts_required jr WHERE jr.job_id = p_job_id
    LOOP
      v_part := public._sg_part_node(v_user, r.part_id);
      IF v_part IS NULL THEN
        CONTINUE;
      END IF;
      IF r.status = 'installed' THEN
        PERFORM public._sg_edge(v_user, v_job, v_part, 'used_part', 'system',
          jsonb_build_object('quantity', r.qty));
        v_used := v_used || v_part;
      ELSE
        PERFORM public._sg_edge(v_user, v_job, v_part, 'requires_part', 'system',
          jsonb_build_object('quantity', r.qty, 'status', r.status));
        v_req := v_req || v_part;
      END IF;
    END LOOP;
    PERFORM public._sg_prune(v_user, v_job, 'used_part', 'out', v_used);
    PERFORM public._sg_prune(v_user, v_job, 'requires_part', 'out', v_req);
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL;
  END;

  -- Job -> Equipment (optional module)
  BEGIN
    FOR r IN
      SELECT je.equipment_id FROM job_equipment je
      JOIN equipment e ON e.id = je.equipment_id
      WHERE je.job_id = p_job_id AND e.user_id = v_user
    LOOP
      PERFORM public._sg_sync_equipment(r.equipment_id);
      v_eq := public._sg_find(v_user, 'equipment', r.equipment_id::text);
      IF v_eq IS NOT NULL THEN
        PERFORM public._sg_edge(v_user, v_job, v_eq, 'serviced');
        v_eq_keep := v_eq_keep || v_eq;
      END IF;
    END LOOP;

    FOR r IN SELECT e.id FROM equipment e
             WHERE to_jsonb(e)->>'install_job_id' = p_job_id::text AND e.user_id = v_user LOOP
      PERFORM public._sg_sync_equipment(r.id);
    END LOOP;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL;
  END;

  -- Callback root-cause analyses (Failure + Future Failure) (optional module)
  BEGIN
    FOR r IN
      SELECT to_jsonb(a) AS a FROM callback_root_cause_analyses a
      WHERE a.user_id = v_user AND COALESCE(a.status, '') <> 'dismissed'
        AND (a.callback_job_id = p_job_id OR a.original_job_id = p_job_id)
    LOOP
      IF (r.a->>'callback_job_id')::uuid = p_job_id THEN
        v_type := NULL;
        v_eq := NULL;
        IF NULLIF(r.a->>'equipment_id', '') IS NOT NULL THEN
          SELECT to_jsonb(e)->>'equipment_type' INTO v_type FROM equipment e
          WHERE e.id = (r.a->>'equipment_id')::uuid AND e.user_id = v_user;
          IF FOUND THEN
            PERFORM public._sg_sync_equipment((r.a->>'equipment_id')::uuid);
            v_eq := public._sg_find(v_user, 'equipment', r.a->>'equipment_id');
          END IF;
        END IF;

        v_fail := public._sg_node(
          v_user, 'failure',
          (r.a->>'root_cause_category') || ':' || COALESCE(NULLIF(lower(btrim(COALESCE(v_type, ''))), ''), 'any'),
          initcap(replace(r.a->>'root_cause_category', '_', ' ')) ||
            CASE WHEN NULLIF(btrim(COALESCE(v_type, '')), '') IS NOT NULL THEN ' · ' || btrim(v_type) ELSE '' END,
          jsonb_build_object('category', r.a->>'root_cause_category', 'equipment_type', v_type)
        );
        PERFORM public._sg_edge(v_user, v_job, v_fail, 'diagnosed', 'system',
          jsonb_build_object('confidence', r.a->>'confidence', 'via', 'callback_root_cause'));
        v_fail_keep := v_fail_keep || v_fail;

        IF v_eq IS NOT NULL THEN
          PERFORM public._sg_edge(v_user, v_fail, v_eq, 'affects');
          PERFORM public._sg_edge(v_user, v_job, v_eq, 'serviced');
          v_eq_keep := v_eq_keep || v_eq;
        END IF;

        IF NULLIF(r.a->>'part_id', '') IS NOT NULL THEN
          v_part := public._sg_part_node(v_user, (r.a->>'part_id')::uuid);
          IF v_part IS NOT NULL THEN
            PERFORM public._sg_edge(v_user, v_fail, v_part, 'caused_by_part');
          END IF;
        END IF;

        v_other := public._sg_find(v_user, 'job', r.a->>'original_job_id');
        IF v_other IS NOT NULL THEN
          PERFORM public._sg_edge(v_user, v_other, v_job, 'led_to_callback', 'system',
            jsonb_build_object('root_cause', r.a->>'root_cause_category'));
          v_cb_in := v_cb_in || v_other;
        END IF;
      ELSE
        v_has_callback := true;
        v_other := public._sg_find(v_user, 'job', r.a->>'callback_job_id');
        IF v_other IS NOT NULL THEN
          PERFORM public._sg_edge(v_user, v_job, v_other, 'led_to_callback', 'system',
            jsonb_build_object('root_cause', r.a->>'root_cause_category'));
          v_cb_out := v_cb_out || v_other;
        END IF;
      END IF;
    END LOOP;
    PERFORM public._sg_prune(v_user, v_job, 'diagnosed', 'out', v_fail_keep);
    PERFORM public._sg_prune(v_user, v_job, 'led_to_callback', 'in', v_cb_in);
    PERFORM public._sg_prune(v_user, v_job, 'led_to_callback', 'out', v_cb_out);
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL;
  END;
  PERFORM public._sg_prune(v_user, v_job, 'serviced', 'out', v_eq_keep);

  -- Warranty claims (optional module)
  v_keep := '{}';
  BEGIN
    FOR r IN SELECT w.id FROM warranty_claims w WHERE w.job_id = p_job_id AND w.user_id = v_user LOOP
      v_has_claim := true;
      PERFORM public._sg_sync_claim(r.id);
      v_claim := public._sg_find(v_user, 'warranty', 'claim:' || r.id::text);
      IF v_claim IS NOT NULL THEN
        v_keep := v_keep || v_claim;
      END IF;
    END LOOP;
    PERFORM public._sg_prune(v_user, v_job, 'claimed_under', 'out', v_keep);
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL;
  END;

  -- Job -> Outcome
  v_keep := '{}';
  IF v_status = 'completed' THEN
    v_out := public._sg_node(v_user, 'outcome', 'completed', 'Completed', '{}'::jsonb);
    PERFORM public._sg_edge(v_user, v_job, v_out, 'resulted_in');
    v_keep := v_keep || v_out;
  ELSIF v_status = 'cancelled' THEN
    v_out := public._sg_node(v_user, 'outcome', 'cancelled', 'Cancelled', '{}'::jsonb);
    PERFORM public._sg_edge(v_user, v_job, v_out, 'resulted_in');
    v_keep := v_keep || v_out;
  END IF;
  IF v_has_callback THEN
    v_out := public._sg_node(v_user, 'outcome', 'callback_required', 'Callback required', '{}'::jsonb);
    PERFORM public._sg_edge(v_user, v_job, v_out, 'resulted_in');
    v_keep := v_keep || v_out;
  END IF;
  IF v_has_claim THEN
    v_out := public._sg_node(v_user, 'outcome', 'warranty_claimed', 'Warranty claimed', '{}'::jsonb);
    PERFORM public._sg_edge(v_user, v_job, v_out, 'resulted_in');
    v_keep := v_keep || v_out;
  END IF;
  PERFORM public._sg_prune(v_user, v_job, 'resulted_in', 'out', v_keep);
END;
$$;

-- =============================================================
-- TRIGGERS (never block core writes)
-- =============================================================

CREATE OR REPLACE FUNCTION public._sg_trg_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
BEGIN
  BEGIN
    -- No-op updates (nothing actually changed) never touch the graph.
    IF TG_OP = 'UPDATE' AND to_jsonb(OLD) IS NOT DISTINCT FROM to_jsonb(NEW) THEN
      RETURN NULL;
    END IF;

    IF TG_TABLE_NAME = 'jobs' THEN
      PERFORM public._sg_sync_job((v->>'id')::uuid);
    ELSIF TG_TABLE_NAME IN ('job_equipment', 'job_parts_required') THEN
      PERFORM public._sg_sync_job((v->>'job_id')::uuid);
    ELSIF TG_TABLE_NAME = 'equipment' THEN
      PERFORM public._sg_sync_equipment((v->>'id')::uuid);
    ELSIF TG_TABLE_NAME = 'customers' THEN
      PERFORM public._sg_sync_customer((v->>'id')::uuid);
    ELSIF TG_TABLE_NAME = 'callback_root_cause_analyses' THEN
      PERFORM public._sg_sync_job((v->>'callback_job_id')::uuid);
      PERFORM public._sg_sync_job((v->>'original_job_id')::uuid);
    ELSIF TG_TABLE_NAME = 'warranty_claims' THEN
      IF v->>'job_id' IS NOT NULL THEN
        PERFORM public._sg_sync_job((v->>'job_id')::uuid);
      END IF;
      IF v->>'equipment_id' IS NOT NULL THEN
        PERFORM public._sg_sync_equipment((v->>'equipment_id')::uuid);
      END IF;
      PERFORM public._sg_sync_claim((v->>'id')::uuid);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'service graph sync skipped (%): %', TG_TABLE_NAME, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public._sg_trg_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v jsonb := to_jsonb(OLD);
  v_user uuid := NULLIF(v->>'user_id', '')::uuid;
BEGIN
  BEGIN
    IF v_user IS NULL THEN
      RETURN NULL;
    END IF;
    IF TG_TABLE_NAME = 'jobs' THEN
      DELETE FROM service_graph_nodes
      WHERE user_id = v_user AND node_type IN ('job', 'payment') AND node_key = v->>'id';
    ELSIF TG_TABLE_NAME = 'equipment' THEN
      DELETE FROM service_graph_nodes
      WHERE user_id = v_user
        AND ((node_type = 'equipment' AND node_key = v->>'id')
          OR (node_type = 'warranty' AND node_key = 'eq:' || (v->>'id')));
    ELSIF TG_TABLE_NAME = 'customers' THEN
      DELETE FROM service_graph_nodes
      WHERE user_id = v_user AND node_type = 'customer' AND node_key = v->>'id';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'service graph cleanup skipped (%): %', TG_TABLE_NAME, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

-- Installs a trigger only when its table exists (no column lists: never fails on schema drift).
CREATE OR REPLACE FUNCTION public._sg_install_trigger(p_table text, p_name text, p_events text, p_fn text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('public.' || quote_ident(p_table)) IS NULL THEN
    RAISE NOTICE 'service graph: table % not found, trigger % skipped', p_table, p_name;
    RETURN;
  END IF;
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', p_name, p_table);
  EXECUTE format(
    'CREATE TRIGGER %I AFTER %s ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()',
    p_name, p_events, p_table, p_fn
  );
END;
$$;

SELECT public._sg_install_trigger('jobs', 'trg_sg_jobs', 'INSERT OR UPDATE', '_sg_trg_sync');
SELECT public._sg_install_trigger('jobs', 'trg_sg_jobs_del', 'DELETE', '_sg_trg_delete');
SELECT public._sg_install_trigger('job_equipment', 'trg_sg_job_equipment', 'INSERT OR UPDATE OR DELETE', '_sg_trg_sync');
SELECT public._sg_install_trigger('job_parts_required', 'trg_sg_job_parts', 'INSERT OR UPDATE OR DELETE', '_sg_trg_sync');
SELECT public._sg_install_trigger('equipment', 'trg_sg_equipment', 'INSERT OR UPDATE', '_sg_trg_sync');
SELECT public._sg_install_trigger('equipment', 'trg_sg_equipment_del', 'DELETE', '_sg_trg_delete');
SELECT public._sg_install_trigger('customers', 'trg_sg_customers', 'INSERT OR UPDATE', '_sg_trg_sync');
SELECT public._sg_install_trigger('customers', 'trg_sg_customers_del', 'DELETE', '_sg_trg_delete');
SELECT public._sg_install_trigger('callback_root_cause_analyses', 'trg_sg_callback_rca', 'INSERT OR UPDATE OR DELETE', '_sg_trg_sync');
SELECT public._sg_install_trigger('warranty_claims', 'trg_sg_warranty_claims', 'INSERT OR UPDATE', '_sg_trg_sync');

-- =============================================================
-- PUBLIC API
-- =============================================================

-- Backfill in pages: phases customers -> equipment -> jobs.
CREATE OR REPLACE FUNCTION public.rebuild_service_graph(
  p_phase text DEFAULT 'jobs', p_offset integer DEFAULT 0, p_limit integer DEFAULT 200
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_id uuid;
  v_fetched integer := 0;
  v_done integer := 0;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_phase NOT IN ('customers', 'equipment', 'jobs') THEN
    RAISE EXCEPTION 'Unknown phase';
  END IF;
  IF to_regclass('public.' || p_phase) IS NULL THEN
    RETURN jsonb_build_object('phase', p_phase, 'fetched', 0, 'processed', 0, 'has_more', false);
  END IF;

  FOR v_id IN EXECUTE format(
    'SELECT id FROM public.%I WHERE user_id = $1 ORDER BY id OFFSET $2 LIMIT $3',
    p_phase
  ) USING v_owner, v_offset, v_limit
  LOOP
    v_fetched := v_fetched + 1;
    BEGIN
      IF p_phase = 'customers' THEN
        PERFORM public._sg_sync_customer(v_id);
      ELSIF p_phase = 'equipment' THEN
        PERFORM public._sg_sync_equipment(v_id);
      ELSE
        PERFORM public._sg_sync_job(v_id);
      END IF;
      v_done := v_done + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'service graph rebuild skipped (% %): %', p_phase, v_id, SQLERRM;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'phase', p_phase, 'fetched', v_fetched, 'processed', v_done,
    'has_more', v_fetched = v_limit
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_service_graph_failure(
  p_job_id uuid, p_failure_code text, p_equipment_id uuid DEFAULT NULL,
  p_part_id uuid DEFAULT NULL, p_note text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_code text;
  v_type text;
  v_job uuid;
  v_eq uuid;
  v_part uuid;
  v_fail uuid;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jobs WHERE id = p_job_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Job not found';
  END IF;

  v_code := btrim(regexp_replace(lower(btrim(COALESCE(p_failure_code, ''))), '[^a-z0-9]+', '_', 'g'), '_');
  IF length(v_code) < 2 OR length(v_code) > 60 THEN
    RAISE EXCEPTION 'Failure code must be 2-60 characters';
  END IF;

  PERFORM public._sg_sync_job(p_job_id);
  v_job := public._sg_find(v_owner, 'job', p_job_id::text);

  IF p_equipment_id IS NOT NULL THEN
    SELECT to_jsonb(e)->>'equipment_type' INTO v_type FROM equipment e
    WHERE e.id = p_equipment_id AND e.user_id = v_owner;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Equipment not found';
    END IF;
    PERFORM public._sg_sync_equipment(p_equipment_id);
    v_eq := public._sg_find(v_owner, 'equipment', p_equipment_id::text);
  END IF;

  IF p_part_id IS NOT NULL THEN
    v_part := public._sg_part_node(v_owner, p_part_id);
    IF v_part IS NULL THEN
      RAISE EXCEPTION 'Part not found';
    END IF;
  END IF;

  v_fail := public._sg_node(
    v_owner, 'failure',
    v_code || ':' || COALESCE(NULLIF(lower(btrim(COALESCE(v_type, ''))), ''), 'any'),
    initcap(replace(v_code, '_', ' ')) ||
      CASE WHEN NULLIF(btrim(COALESCE(v_type, '')), '') IS NOT NULL THEN ' · ' || btrim(v_type) ELSE '' END,
    jsonb_build_object('category', v_code, 'equipment_type', v_type)
  );

  PERFORM public._sg_edge(v_owner, v_job, v_fail, 'diagnosed', 'staff',
    jsonb_build_object('note', left(NULLIF(btrim(COALESCE(p_note, '')), ''), 300), 'via', 'manual'));
  IF v_eq IS NOT NULL THEN
    PERFORM public._sg_edge(v_owner, v_fail, v_eq, 'affects', 'staff');
    PERFORM public._sg_edge(v_owner, v_job, v_eq, 'serviced', 'staff');
  END IF;
  IF v_part IS NOT NULL THEN
    PERFORM public._sg_edge(v_owner, v_fail, v_part, 'caused_by_part', 'staff');
  END IF;

  RETURN v_fail;
END;
$$;

CREATE OR REPLACE FUNCTION public.service_graph_stats()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN jsonb_build_object(
    'nodes_by_type', COALESCE((
      SELECT jsonb_object_agg(t.node_type, t.c)
      FROM (SELECT node_type, COUNT(*)::int AS c FROM service_graph_nodes
            WHERE user_id = v_owner GROUP BY node_type) t
    ), '{}'::jsonb),
    'node_count', (SELECT COUNT(*)::int FROM service_graph_nodes WHERE user_id = v_owner),
    'edge_count', (SELECT COUNT(*)::int FROM service_graph_edges WHERE user_id = v_owner),
    'jobs_in_graph', (SELECT COUNT(*)::int FROM service_graph_nodes WHERE user_id = v_owner AND node_type = 'job'),
    'jobs_total', (SELECT COUNT(*)::int FROM jobs WHERE user_id = v_owner),
    'last_updated', (SELECT MAX(updated_at) FROM service_graph_nodes WHERE user_id = v_owner)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.service_graph_search(
  p_query text DEFAULT NULL, p_type text DEFAULT NULL, p_limit integer DEFAULT 20
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_q text := NULLIF(btrim(COALESCE(p_query, '')), '');
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(x)) FROM (
      SELECT n.id, n.node_key, n.node_type, n.label, n.properties, n.updated_at,
        (SELECT COUNT(*)::int FROM service_graph_edges e
          WHERE e.user_id = v_owner AND (e.from_node = n.id OR e.to_node = n.id)) AS degree
      FROM service_graph_nodes n
      WHERE n.user_id = v_owner
        AND (p_type IS NULL OR n.node_type = p_type)
        AND (v_q IS NULL OR n.label ILIKE '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%')
      ORDER BY n.updated_at DESC
      LIMIT v_limit
    ) x
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.service_graph_neighborhood(p_node_id uuid, p_depth integer DEFAULT 2)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_depth integer := LEAST(GREATEST(COALESCE(p_depth, 2), 1), 3);
  v_seen uuid[];
  v_frontier uuid[];
  v_next uuid[];
  v_i integer;
  v_nodes jsonb;
  v_edges jsonb;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM service_graph_nodes WHERE id = p_node_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Node not found';
  END IF;

  v_seen := ARRAY[p_node_id];
  v_frontier := ARRAY[p_node_id];

  FOR v_i IN 1..v_depth LOOP
    EXIT WHEN COALESCE(cardinality(v_frontier), 0) = 0 OR cardinality(v_seen) >= 150;

    SELECT COALESCE(array_agg(DISTINCT s.nb), '{}'::uuid[]) INTO v_next
    FROM (
      SELECT CASE WHEN e.from_node = ANY (v_frontier) THEN e.to_node ELSE e.from_node END AS nb
      FROM service_graph_edges e
      WHERE e.user_id = v_owner
        AND (e.from_node = ANY (v_frontier) OR e.to_node = ANY (v_frontier))
      ORDER BY e.last_seen_at DESC
      LIMIT 300
    ) s
    WHERE NOT (s.nb = ANY (v_seen));

    SELECT COALESCE(array_agg(q.id), '{}'::uuid[]) INTO v_next
    FROM (SELECT u AS id FROM unnest(v_next) AS u LIMIT GREATEST(0, 150 - cardinality(v_seen))) q;

    v_seen := v_seen || v_next;

    -- Hub nodes (outcomes) are shown but never expanded.
    SELECT COALESCE(array_agg(n.id), '{}'::uuid[]) INTO v_frontier
    FROM service_graph_nodes n
    WHERE n.id = ANY (v_next) AND n.node_type <> 'outcome';
  END LOOP;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', n.id, 'node_key', n.node_key, 'node_type', n.node_type, 'label', n.label,
    'properties', n.properties, 'is_root', n.id = p_node_id
  )), '[]'::jsonb) INTO v_nodes
  FROM service_graph_nodes n
  WHERE n.id = ANY (v_seen) AND n.user_id = v_owner;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', e.id, 'from_node', e.from_node, 'to_node', e.to_node, 'relation', e.relation,
    'source', e.source, 'evidence', e.evidence, 'last_seen_at', e.last_seen_at
  )), '[]'::jsonb) INTO v_edges
  FROM (
    SELECT * FROM service_graph_edges
    WHERE user_id = v_owner AND from_node = ANY (v_seen) AND to_node = ANY (v_seen)
    ORDER BY last_seen_at DESC
    LIMIT 500
  ) e;

  RETURN jsonb_build_object('nodes', v_nodes, 'edges', v_edges, 'truncated', cardinality(v_seen) >= 150);
END;
$$;

-- Transparent, graph-derived reasoning (no hidden scoring).
-- equipment risk = 100 * min(1, 0.6*group_failure_rate + 0.25*age_ratio + 0.15*(own_failures>0))
-- group_failure_rate only counts when >= 3 units share make+model+type.
CREATE OR REPLACE FUNCTION public.service_graph_insights()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_failures jsonb;
  v_parts jsonb;
  v_techs jsonb;
  v_groups jsonb;
  v_units jsonb;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Failure patterns
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.jobs DESC, x.label), '[]'::jsonb) INTO v_failures
  FROM (
    SELECT f.id AS node_id, f.label, f.properties->>'category' AS category,
           COUNT(DISTINCT d.from_node)::int AS jobs,
           COUNT(DISTINCT cb.to_node)::int AS callbacks,
           COALESCE((
             SELECT jsonb_agg(q.label) FROM (
               SELECT pn.label FROM service_graph_edges pe
               JOIN service_graph_nodes pn ON pn.id = pe.to_node
               WHERE pe.user_id = v_owner AND pe.from_node = f.id AND pe.relation = 'caused_by_part'
               ORDER BY pn.label LIMIT 3
             ) q
           ), '[]'::jsonb) AS parts
    FROM service_graph_nodes f
    JOIN service_graph_edges d ON d.user_id = v_owner AND d.to_node = f.id AND d.relation = 'diagnosed'
    LEFT JOIN service_graph_edges cb ON cb.user_id = v_owner AND cb.from_node = d.from_node AND cb.relation = 'led_to_callback'
    WHERE f.user_id = v_owner AND f.node_type = 'failure'
    GROUP BY f.id
    ORDER BY COUNT(DISTINCT d.from_node) DESC, f.label
    LIMIT 10
  ) x;

  -- Part signals
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.failure_jobs DESC, x.label), '[]'::jsonb) INTO v_parts
  FROM (
    SELECT y.node_id, y.label, y.used_in_jobs, y.failure_jobs,
           ROUND(LEAST(1, y.failure_jobs::numeric / NULLIF(y.used_in_jobs, 0)), 3) AS failure_rate
    FROM (
      SELECT p.id AS node_id, p.label,
        (SELECT COUNT(*)::int FROM service_graph_edges u
          WHERE u.user_id = v_owner AND u.to_node = p.id AND u.relation = 'used_part') AS used_in_jobs,
        (SELECT COUNT(DISTINCT dj.from_node)::int FROM service_graph_edges cp
          JOIN service_graph_edges dj ON dj.user_id = v_owner AND dj.relation = 'diagnosed' AND dj.to_node = cp.from_node
          WHERE cp.user_id = v_owner AND cp.to_node = p.id AND cp.relation = 'caused_by_part') AS failure_jobs
      FROM service_graph_nodes p
      WHERE p.user_id = v_owner AND p.node_type = 'part'
    ) y
    WHERE y.failure_jobs > 0
    ORDER BY y.failure_jobs DESC, y.label
    LIMIT 10
  ) x;

  -- Technician signals (callbacks that originated from jobs they handled)
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.callbacks DESC, x.jobs_handled DESC, x.label), '[]'::jsonb) INTO v_techs
  FROM (
    SELECT y.node_id, y.label, y.jobs_handled, y.callbacks,
           ROUND(y.callbacks::numeric / NULLIF(y.jobs_handled, 0), 3) AS callback_rate
    FROM (
      SELECT t.id AS node_id, t.label,
             COUNT(DISTINCT h.from_node)::int AS jobs_handled,
             COUNT(DISTINCT cb.to_node)::int AS callbacks
      FROM service_graph_nodes t
      JOIN service_graph_edges h ON h.user_id = v_owner AND h.to_node = t.id AND h.relation = 'handled_by'
      LEFT JOIN service_graph_edges cb ON cb.user_id = v_owner AND cb.from_node = h.from_node AND cb.relation = 'led_to_callback'
      WHERE t.user_id = v_owner AND t.node_type = 'technician'
      GROUP BY t.id
    ) y
    WHERE y.callbacks > 0
    ORDER BY y.callbacks DESC, y.jobs_handled DESC, y.label
    LIMIT 10
  ) x;

  -- Equipment groups + per-unit future-failure risk
  WITH eq AS (
    SELECT n.id, n.label,
      COALESCE(NULLIF(n.properties->>'make', ''), 'Unknown make') AS make,
      COALESCE(NULLIF(n.properties->>'model', ''), 'Unknown model') AS model,
      COALESCE(NULLIF(n.properties->>'type', ''), 'Unknown type') AS eq_type,
      COALESCE(n.properties->>'status', 'active') AS status,
      public._sg_date(n.properties->>'install_date') AS install_date,
      COALESCE(
        CASE WHEN n.properties->>'expected_lifespan_years' ~ '^[0-9]+(\.[0-9]+)?$'
             THEN (n.properties->>'expected_lifespan_years')::numeric END, 15) AS lifespan,
      (SELECT COUNT(DISTINCT s.from_node)::int FROM service_graph_edges s
        JOIN service_graph_edges d ON d.user_id = v_owner AND d.from_node = s.from_node AND d.relation = 'diagnosed'
        WHERE s.user_id = v_owner AND s.to_node = n.id AND s.relation = 'serviced') AS failure_jobs
    FROM service_graph_nodes n
    WHERE n.user_id = v_owner AND n.node_type = 'equipment'
  ),
  grp AS (
    SELECT make, model, eq_type, COUNT(*)::int AS units,
           COUNT(*) FILTER (WHERE failure_jobs > 0)::int AS failed_units
    FROM eq GROUP BY make, model, eq_type
  ),
  scored AS (
    SELECT e.id AS node_id, e.label, e.make, e.model, e.eq_type AS equipment_type, e.status,
           e.failure_jobs AS own_failures, g.units AS sample_size,
           CASE WHEN g.units >= 3 THEN ROUND(g.failed_units::numeric / g.units, 3) ELSE NULL END AS group_failure_rate,
           CASE WHEN e.install_date IS NULL THEN 0
                ELSE ROUND(LEAST(1, GREATEST(0, ((CURRENT_DATE - e.install_date)::numeric / 365.25) / GREATEST(e.lifespan, 1))), 3)
           END AS age_ratio
    FROM eq e
    JOIN grp g ON g.make = e.make AND g.model = e.model AND g.eq_type = e.eq_type
  ),
  ranked AS (
    SELECT s.*,
           ROUND(100 * LEAST(1, 0.6 * COALESCE(s.group_failure_rate, 0) + 0.25 * s.age_ratio
             + 0.15 * CASE WHEN s.own_failures > 0 THEN 1 ELSE 0 END))::int AS risk_score
    FROM scored s
  )
  SELECT
    COALESCE((
      SELECT jsonb_agg(to_jsonb(g2) ORDER BY g2.failure_rate DESC, g2.units DESC) FROM (
        SELECT make, model, eq_type AS equipment_type, units, failed_units,
               ROUND(failed_units::numeric / units, 3) AS failure_rate
        FROM grp WHERE units >= 3 AND failed_units > 0
        ORDER BY failed_units::numeric / units DESC, units DESC
        LIMIT 10
      ) g2
    ), '[]'::jsonb),
    COALESCE((
     SELECT jsonb_agg(to_jsonb(r2) ORDER BY r2.risk_score DESC, r2.label) FROM (
        SELECT node_id, label, make, model, equipment_type, sample_size, group_failure_rate,
               age_ratio, own_failures, risk_score
        FROM ranked WHERE status = 'active' AND risk_score > 0
        ORDER BY risk_score DESC, label
        LIMIT 10
      ) r2
    ), '[]'::jsonb)
  INTO v_groups, v_units;

  RETURN jsonb_build_object(
    'failure_patterns', v_failures,
    'part_signals', v_parts,
    'technician_signals', v_techs,
    'equipment_groups', v_groups,
    'equipment_risk', v_units,
    'generated_at', now()
  );
END;
$$;

-- =============================================================
-- PERMISSIONS
-- =============================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE '\_sg\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_service_graph(text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_service_graph_failure(uuid, text, uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.service_graph_stats() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.service_graph_search(text, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.service_graph_neighborhood(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.service_graph_insights() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.rebuild_service_graph(text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_service_graph_failure(uuid, text, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.service_graph_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.service_graph_search(text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.service_graph_neighborhood(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.service_graph_insights() TO authenticated;
