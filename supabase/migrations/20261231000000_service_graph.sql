/*
  # Vireek Service Graph (Vireek Intelligence Graph)

  Persistent graph: Customer -> Property -> Equipment -> Failure -> Technician
  -> Part -> Job -> Outcome -> Warranty -> Future Failure (callback).

  - service_graph_nodes / service_graph_edges : read-only for clients (RLS).
  - All writes happen through SECURITY DEFINER functions and triggers.
  - Triggers never block core operations: errors become WARNINGs.
  - No invoice amounts are stored in the graph (billing data stays gated).
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
  tm team_members%ROWTYPE;
BEGIN
  SELECT * INTO tm FROM team_members WHERE id = p_member AND account_owner_id = p_user;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN public._sg_node(
    p_user, 'technician', tm.id::text,
    COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email),
    jsonb_build_object('role', tm.role)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._sg_part_node(p_user uuid, p_part uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  pt inventory_parts%ROWTYPE;
  v_id uuid;
  v_vendor uuid;
  r record;
BEGIN
  SELECT * INTO pt FROM inventory_parts WHERE id = p_part AND user_id = p_user;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_id := public._sg_node(
    p_user, 'part', pt.id::text,
    COALESCE(NULLIF(btrim(pt.part_number), '') || ' · ', '') || pt.name,
    jsonb_build_object('part_number', pt.part_number, 'name', pt.name, 'category', pt.category)
  );

  FOR r IN
    SELECT vd.id, vd.name, pv.is_preferred, pv.lead_time_days
    FROM inventory_part_vendors pv
    JOIN inventory_vendors vd ON vd.id = pv.vendor_id
    WHERE pv.part_id = pt.id AND pv.user_id = p_user AND vd.user_id = p_user
  LOOP
    v_vendor := public._sg_node(p_user, 'vendor', r.id::text, r.name, '{}'::jsonb);
    PERFORM public._sg_edge(
      p_user, v_id, v_vendor, 'supplied_by', 'system',
      jsonb_build_object('preferred', r.is_preferred, 'lead_time_days', r.lead_time_days)
    );
  END LOOP;

  RETURN v_id;
END;
$$;

-- =============================================================
-- ENTITY SYNC (idempotent; safe to re-run)
-- =============================================================

CREATE OR REPLACE FUNCTION public._sg_sync_customer(p_customer_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cu customers%ROWTYPE;
  v_cust uuid;
  v_prop uuid;
  v_addr text;
BEGIN
  SELECT * INTO cu FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_cust := public._sg_node(
    cu.user_id, 'customer', cu.id::text, cu.name,
    jsonb_build_object('customer_type', cu.customer_type, 'lifecycle_stage', cu.lifecycle_stage)
  );

  v_addr := public._sg_norm_address(cu.address);
  IF v_addr IS NOT NULL THEN
    v_prop := public._sg_node(cu.user_id, 'property', v_addr, btrim(cu.address), '{}'::jsonb);
    PERFORM public._sg_edge(cu.user_id, v_cust, v_prop, 'has_property');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._sg_sync_equipment(p_equipment_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  eq equipment%ROWTYPE;
  cu customers%ROWTYPE;
  v_eq uuid;
  v_cust uuid;
  v_prop uuid;
  v_job uuid;
  v_war uuid;
  v_addr text;
  v_keep uuid[] := '{}';
BEGIN
  SELECT * INTO eq FROM equipment WHERE id = p_equipment_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_eq := public._sg_node(
    eq.user_id, 'equipment', eq.id::text,
    COALESCE(NULLIF(concat_ws(' · ', NULLIF(btrim(eq.make), ''), NULLIF(btrim(eq.model), ''), NULLIF(btrim(eq.equipment_type), '')), ''), 'Equipment'),
    jsonb_build_object(
      'type', eq.equipment_type, 'make', eq.make, 'model', eq.model,
      'install_date', eq.install_date, 'status', eq.status,
      'expected_lifespan_years', eq.expected_lifespan_years,
      'warranty_expires_at', eq.warranty_expires_at
    )
  );

  SELECT * INTO cu FROM customers WHERE id = eq.customer_id AND user_id = eq.user_id;
  IF FOUND THEN
    PERFORM public._sg_sync_customer(cu.id);
    v_cust := public._sg_find(eq.user_id, 'customer', cu.id::text);
    PERFORM public._sg_edge(eq.user_id, v_cust, v_eq, 'owns_equipment');
    v_addr := public._sg_norm_address(cu.address);
    IF v_addr IS NOT NULL THEN
      v_prop := public._sg_find(eq.user_id, 'property', v_addr);
      PERFORM public._sg_edge(eq.user_id, v_prop, v_eq, 'has_equipment');
    END IF;
  END IF;

  IF eq.install_job_id IS NOT NULL THEN
    v_job := public._sg_find(eq.user_id, 'job', eq.install_job_id::text);
    IF v_job IS NOT NULL THEN
      PERFORM public._sg_edge(eq.user_id, v_job, v_eq, 'installed');
    END IF;
  END IF;

  IF eq.warranty_expires_at IS NOT NULL THEN
    v_war := public._sg_node(
      eq.user_id, 'warranty', 'eq:' || eq.id::text,
      'Warranty until ' || to_char(eq.warranty_expires_at, 'YYYY-MM-DD'),
      jsonb_build_object('kind', 'equipment', 'expires_at', eq.warranty_expires_at)
    );
    PERFORM public._sg_edge(eq.user_id, v_eq, v_war, 'covered_by');
    v_keep := ARRAY[v_war];
  END IF;
  PERFORM public._sg_prune(eq.user_id, v_eq, 'covered_by', 'out', v_keep);
END;
$$;

CREATE OR REPLACE FUNCTION public._sg_sync_claim(p_claim_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  wc warranty_claims%ROWTYPE;
  v_w uuid;
  v_job uuid;
  v_eq uuid;
BEGIN
  SELECT * INTO wc FROM warranty_claims WHERE id = p_claim_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_w := public._sg_node(
    wc.user_id, 'warranty', 'claim:' || wc.id::text,
    'Warranty claim · ' || replace(wc.status, '_', ' '),
    jsonb_build_object('kind', 'claim', 'status', wc.status, 'manufacturer', wc.manufacturer)
  );

  IF wc.job_id IS NOT NULL THEN
    v_job := public._sg_find(wc.user_id, 'job', wc.job_id::text);
    IF v_job IS NOT NULL THEN
      PERFORM public._sg_edge(wc.user_id, v_job, v_w, 'claimed_under');
    END IF;
  END IF;

  IF wc.equipment_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM equipment WHERE id = wc.equipment_id AND user_id = wc.user_id) THEN
    PERFORM public._sg_sync_equipment(wc.equipment_id);
    v_eq := public._sg_find(wc.user_id, 'equipment', wc.equipment_id::text);
    PERFORM public._sg_edge(wc.user_id, v_eq, v_w, 'has_claim');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._sg_sync_job(p_job_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  jb jobs%ROWTYPE;
  cu customers%ROWTYPE;
  r record;
  v_job uuid; v_cust uuid; v_prop uuid; v_tech uuid; v_call uuid; v_pay uuid;
  v_part uuid; v_eq uuid; v_fail uuid; v_other uuid; v_claim uuid; v_out uuid;
  v_type text;
  v_addr text;
  v_keep uuid[];
  v_used uuid[] := '{}';
  v_req uuid[] := '{}';
  v_eq_keep uuid[] := '{}';
  v_fail_keep uuid[] := '{}';
  v_cb_in uuid[] := '{}';
  v_cb_out uuid[] := '{}';
  v_has_callback boolean := false;
BEGIN
  SELECT * INTO jb FROM jobs WHERE id = p_job_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_job := public._sg_node(
    jb.user_id, 'job', jb.id::text,
    COALESCE(NULLIF(btrim(COALESCE(jb.service_type, '')), ''), 'Job') || ' · ' ||
      COALESCE(NULLIF(btrim(COALESCE(jb.customer_name, '')), ''), 'Customer'),
    jsonb_build_object(
      'status', jb.job_status, 'service_type', jb.service_type,
      'scheduled_at', jb.scheduled_datetime, 'created_at', jb.created_at
    )
  );

  -- Customer -> Job
  v_keep := '{}';
  IF jb.customer_id IS NOT NULL THEN
    SELECT * INTO cu FROM customers WHERE id = jb.customer_id AND user_id = jb.user_id;
    IF FOUND THEN
      PERFORM public._sg_sync_customer(cu.id);
      v_cust := public._sg_find(jb.user_id, 'customer', cu.id::text);
      PERFORM public._sg_edge(jb.user_id, v_cust, v_job, 'requested');
      v_keep := ARRAY[v_cust];
    END IF;
  END IF;
  PERFORM public._sg_prune(jb.user_id, v_job, 'requested', 'in', v_keep);

  -- Job -> Property
  v_keep := '{}';
  v_addr := public._sg_norm_address(COALESCE(NULLIF(btrim(jb.address), ''), cu.address));
  IF v_addr IS NOT NULL THEN
    v_prop := public._sg_node(
      jb.user_id, 'property', v_addr,
      btrim(COALESCE(NULLIF(btrim(jb.address), ''), cu.address)), '{}'::jsonb
    );
    PERFORM public._sg_edge(jb.user_id, v_job, v_prop, 'performed_at');
    IF v_cust IS NOT NULL THEN
      PERFORM public._sg_edge(jb.user_id, v_cust, v_prop, 'has_property');
    END IF;
    v_keep := ARRAY[v_prop];
  END IF;
  PERFORM public._sg_prune(jb.user_id, v_job, 'performed_at', 'out', v_keep);

  -- Job -> Technician
  v_keep := '{}';
  IF jb.assigned_technician_id IS NOT NULL THEN
    v_tech := public._sg_tech_node(jb.user_id, jb.assigned_technician_id);
    IF v_tech IS NOT NULL THEN
      PERFORM public._sg_edge(jb.user_id, v_job, v_tech, 'handled_by');
      v_keep := ARRAY[v_tech];
    END IF;
  END IF;
  PERFORM public._sg_prune(jb.user_id, v_job, 'handled_by', 'out', v_keep);

  -- Call -> Job
  v_keep := '{}';
  IF jb.call_id IS NOT NULL THEN
    SELECT id, call_datetime INTO r FROM calls WHERE id = jb.call_id AND user_id = jb.user_id;
    IF FOUND THEN
      v_call := public._sg_node(
        jb.user_id, 'call', r.id::text,
        'Call · ' || to_char(r.call_datetime, 'YYYY-MM-DD'), '{}'::jsonb
      );
      PERFORM public._sg_edge(jb.user_id, v_call, v_job, 'originated');
      v_keep := ARRAY[v_call];
    END IF;
  END IF;
  PERFORM public._sg_prune(jb.user_id, v_job, 'originated', 'in', v_keep);

  -- Job -> Payment (status only, no amounts)
  v_keep := '{}';
  IF jb.invoice_amount IS NOT NULL THEN
    v_pay := public._sg_node(
      jb.user_id, 'payment', jb.id::text,
      'Invoice · ' || replace(COALESCE(jb.invoice_status, 'not_sent'), '_', ' '),
      jsonb_build_object('status', jb.invoice_status)
    );
    PERFORM public._sg_edge(jb.user_id, v_job, v_pay, 'billed_as');
    v_keep := ARRAY[v_pay];
  END IF;
  PERFORM public._sg_prune(jb.user_id, v_job, 'billed_as', 'out', v_keep);

  -- Job -> Parts
  FOR r IN
    SELECT jr.part_id, jr.status, jr.quantity_required
    FROM job_parts_required jr
    WHERE jr.job_id = jb.id
  LOOP
    v_part := public._sg_part_node(jb.user_id, r.part_id);
    IF v_part IS NULL THEN
      CONTINUE;
    END IF;
    IF r.status = 'installed' THEN
      PERFORM public._sg_edge(jb.user_id, v_job, v_part, 'used_part', 'system',
        jsonb_build_object('quantity', r.quantity_required));
      v_used := v_used || v_part;
    ELSE
      PERFORM public._sg_edge(jb.user_id, v_job, v_part, 'requires_part', 'system',
        jsonb_build_object('quantity', r.quantity_required, 'status', r.status));
      v_req := v_req || v_part;
    END IF;
  END LOOP;
  PERFORM public._sg_prune(jb.user_id, v_job, 'used_part', 'out', v_used);
  PERFORM public._sg_prune(jb.user_id, v_job, 'requires_part', 'out', v_req);

  -- Job -> Equipment
  FOR r IN
    SELECT je.equipment_id
    FROM job_equipment je
    JOIN equipment e ON e.id = je.equipment_id
    WHERE je.job_id = jb.id AND e.user_id = jb.user_id
  LOOP
    PERFORM public._sg_sync_equipment(r.equipment_id);
    v_eq := public._sg_find(jb.user_id, 'equipment', r.equipment_id::text);
    IF v_eq IS NOT NULL THEN
      PERFORM public._sg_edge(jb.user_id, v_job, v_eq, 'serviced');
      v_eq_keep := v_eq_keep || v_eq;
    END IF;
  END LOOP;

  FOR r IN SELECT id FROM equipment WHERE install_job_id = jb.id AND user_id = jb.user_id LOOP
    PERFORM public._sg_sync_equipment(r.id);
  END LOOP;

  -- Callback root-cause analyses (Failure + Future Failure)
  FOR r IN
    SELECT * FROM callback_root_cause_analyses a
    WHERE a.user_id = jb.user_id AND a.status <> 'dismissed'
      AND (a.callback_job_id = jb.id OR a.original_job_id = jb.id)
  LOOP
    IF r.callback_job_id = jb.id THEN
      v_type := NULL;
      v_eq := NULL;
      IF r.equipment_id IS NOT NULL THEN
        SELECT e.equipment_type INTO v_type FROM equipment e
        WHERE e.id = r.equipment_id AND e.user_id = jb.user_id;
        IF FOUND THEN
          PERFORM public._sg_sync_equipment(r.equipment_id);
          v_eq := public._sg_find(jb.user_id, 'equipment', r.equipment_id::text);
        END IF;
      END IF;

      v_fail := public._sg_node(
        jb.user_id, 'failure',
        r.root_cause_category || ':' || COALESCE(NULLIF(lower(btrim(COALESCE(v_type, ''))), ''), 'any'),
        initcap(replace(r.root_cause_category, '_', ' ')) ||
          CASE WHEN NULLIF(btrim(COALESCE(v_type, '')), '') IS NOT NULL THEN ' · ' || btrim(v_type) ELSE '' END,
        jsonb_build_object('category', r.root_cause_category, 'equipment_type', v_type)
      );
      PERFORM public._sg_edge(jb.user_id, v_job, v_fail, 'diagnosed', 'system',
        jsonb_build_object('confidence', r.confidence, 'via', 'callback_root_cause'));
      v_fail_keep := v_fail_keep || v_fail;

      IF v_eq IS NOT NULL THEN
        PERFORM public._sg_edge(jb.user_id, v_fail, v_eq, 'affects');
        PERFORM public._sg_edge(jb.user_id, v_job, v_eq, 'serviced');
        v_eq_keep := v_eq_keep || v_eq;
      END IF;

      IF r.part_id IS NOT NULL THEN
        v_part := public._sg_part_node(jb.user_id, r.part_id);
        IF v_part IS NOT NULL THEN
          PERFORM public._sg_edge(jb.user_id, v_fail, v_part, 'caused_by_part');
        END IF;
      END IF;

      v_other := public._sg_find(jb.user_id, 'job', r.original_job_id::text);
      IF v_other IS NOT NULL THEN
        PERFORM public._sg_edge(jb.user_id, v_other, v_job, 'led_to_callback', 'system',
          jsonb_build_object('root_cause', r.root_cause_category));
        v_cb_in := v_cb_in || v_other;
      END IF;
    ELSE
      v_has_callback := true;
      v_other := public._sg_find(jb.user_id, 'job', r.callback_job_id::text);
      IF v_other IS NOT NULL THEN
        PERFORM public._sg_edge(jb.user_id, v_job, v_other, 'led_to_callback', 'system',
          jsonb_build_object('root_cause', r.root_cause_category));
        v_cb_out := v_cb_out || v_other;
      END IF;
    END IF;
  END LOOP;
  PERFORM public._sg_prune(jb.user_id, v_job, 'serviced', 'out', v_eq_keep);
  PERFORM public._sg_prune(jb.user_id, v_job, 'diagnosed', 'out', v_fail_keep);
  PERFORM public._sg_prune(jb.user_id, v_job, 'led_to_callback', 'in', v_cb_in);
  PERFORM public._sg_prune(jb.user_id, v_job, 'led_to_callback', 'out', v_cb_out);

  -- Warranty claims
  v_keep := '{}';
  FOR r IN SELECT id FROM warranty_claims WHERE job_id = jb.id AND user_id = jb.user_id LOOP
    PERFORM public._sg_sync_claim(r.id);
    v_claim := public._sg_find(jb.user_id, 'warranty', 'claim:' || r.id::text);
    IF v_claim IS NOT NULL THEN
      v_keep := v_keep || v_claim;
    END IF;
  END LOOP;
  PERFORM public._sg_prune(jb.user_id, v_job, 'claimed_under', 'out', v_keep);

  -- Job -> Outcome
  v_keep := '{}';
  IF jb.job_status = 'completed' THEN
    v_out := public._sg_node(jb.user_id, 'outcome', 'completed', 'Completed', '{}'::jsonb);
    PERFORM public._sg_edge(jb.user_id, v_job, v_out, 'resulted_in');
    v_keep := v_keep || v_out;
  ELSIF jb.job_status = 'cancelled' THEN
    v_out := public._sg_node(jb.user_id, 'outcome', 'cancelled', 'Cancelled', '{}'::jsonb);
    PERFORM public._sg_edge(jb.user_id, v_job, v_out, 'resulted_in');
    v_keep := v_keep || v_out;
  END IF;
  IF v_has_callback THEN
    v_out := public._sg_node(jb.user_id, 'outcome', 'callback_required', 'Callback required', '{}'::jsonb);
    PERFORM public._sg_edge(jb.user_id, v_job, v_out, 'resulted_in');
    v_keep := v_keep || v_out;
  END IF;
  IF EXISTS (SELECT 1 FROM warranty_claims w WHERE w.job_id = jb.id AND w.user_id = jb.user_id) THEN
    v_out := public._sg_node(jb.user_id, 'outcome', 'warranty_claimed', 'Warranty claimed', '{}'::jsonb);
    PERFORM public._sg_edge(jb.user_id, v_job, v_out, 'resulted_in');
    v_keep := v_keep || v_out;
  END IF;
  PERFORM public._sg_prune(jb.user_id, v_job, 'resulted_in', 'out', v_keep);
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
BEGIN
  BEGIN
    IF TG_TABLE_NAME = 'jobs' THEN
      DELETE FROM service_graph_nodes
      WHERE user_id = OLD.user_id AND node_type IN ('job', 'payment') AND node_key = OLD.id::text;
    ELSIF TG_TABLE_NAME = 'equipment' THEN
      DELETE FROM service_graph_nodes
      WHERE user_id = OLD.user_id
        AND ((node_type = 'equipment' AND node_key = OLD.id::text)
          OR (node_type = 'warranty' AND node_key = 'eq:' || OLD.id::text));
    ELSIF TG_TABLE_NAME = 'customers' THEN
      DELETE FROM service_graph_nodes
      WHERE user_id = OLD.user_id AND node_type = 'customer' AND node_key = OLD.id::text;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'service graph cleanup skipped (%): %', TG_TABLE_NAME, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sg_jobs ON jobs;
CREATE TRIGGER trg_sg_jobs
  AFTER INSERT OR UPDATE OF customer_id, assigned_technician_id, job_status, invoice_amount,
    invoice_status, address, call_id, service_type, customer_name ON jobs
  FOR EACH ROW EXECUTE FUNCTION public._sg_trg_sync();

DROP TRIGGER IF EXISTS trg_sg_jobs_del ON jobs;
CREATE TRIGGER trg_sg_jobs_del AFTER DELETE ON jobs
  FOR EACH ROW EXECUTE FUNCTION public._sg_trg_delete();

DROP TRIGGER IF EXISTS trg_sg_job_equipment ON job_equipment;
CREATE TRIGGER trg_sg_job_equipment AFTER INSERT OR UPDATE OR DELETE ON job_equipment
  FOR EACH ROW EXECUTE FUNCTION public._sg_trg_sync();

DROP TRIGGER IF EXISTS trg_sg_job_parts ON job_parts_required;
CREATE TRIGGER trg_sg_job_parts AFTER INSERT OR UPDATE OR DELETE ON job_parts_required
  FOR EACH ROW EXECUTE FUNCTION public._sg_trg_sync();

DROP TRIGGER IF EXISTS trg_sg_equipment ON equipment;
CREATE TRIGGER trg_sg_equipment AFTER INSERT OR UPDATE ON equipment
  FOR EACH ROW EXECUTE FUNCTION public._sg_trg_sync();

DROP TRIGGER IF EXISTS trg_sg_equipment_del ON equipment;
CREATE TRIGGER trg_sg_equipment_del AFTER DELETE ON equipment
  FOR EACH ROW EXECUTE FUNCTION public._sg_trg_delete();

DROP TRIGGER IF EXISTS trg_sg_customers ON customers;
CREATE TRIGGER trg_sg_customers
  AFTER INSERT OR UPDATE OF name, address, customer_type, lifecycle_stage ON customers
  FOR EACH ROW EXECUTE FUNCTION public._sg_trg_sync();

DROP TRIGGER IF EXISTS trg_sg_customers_del ON customers;
CREATE TRIGGER trg_sg_customers_del AFTER DELETE ON customers
  FOR EACH ROW EXECUTE FUNCTION public._sg_trg_delete();

DROP TRIGGER IF EXISTS trg_sg_callback_rca ON callback_root_cause_analyses;
CREATE TRIGGER trg_sg_callback_rca AFTER INSERT OR UPDATE OR DELETE ON callback_root_cause_analyses
  FOR EACH ROW EXECUTE FUNCTION public._sg_trg_sync();

DROP TRIGGER IF EXISTS trg_sg_warranty_claims ON warranty_claims;
CREATE TRIGGER trg_sg_warranty_claims AFTER INSERT OR UPDATE ON warranty_claims
  FOR EACH ROW EXECUTE FUNCTION public._sg_trg_sync();

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

  FOR v_id IN EXECUTE format(
    'SELECT id FROM %I WHERE user_id = $1 ORDER BY created_at, id OFFSET $2 LIMIT $3',
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
    SELECT e.equipment_type INTO v_type FROM equipment e
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
    LEFT JOIN service_graph_edges cb ON cb.user_id = v_owner AND cb.to_node = d.from_node AND cb.relation = 'led_to_callback'
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
      NULLIF(n.properties->>'install_date', '')::date AS install_date,
      COALESCE(NULLIF(n.properties->>'expected_lifespan_years', '')::numeric, 15) AS lifespan,
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
