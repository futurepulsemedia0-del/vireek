/*
  # Vireek Integration / Data Fabric — Universal Service Data Layer

  Any external system (CRM, ERP, accounting, OEM, IoT, telematics, maps,
  payments, inventory, phone, email, calendar, insurance, warranty,
  government, marketplace) pushes records through the `fabric-ingest` edge
  function. Every record is:

    1. landed idempotently in `fabric_records` (raw + canonical payload, hash,
       status, retry counters — a built-in dead-letter queue),
    2. identity-resolved against what Vireek already knows (email / phone /
       serial number / normalized address), and
    3. projected into the existing canonical service graph
       (`service_graph_nodes` / `service_graph_edges`) with per-node
       provenance in `properties.fabric_sources`.

  Security model
  - Clients can only READ (RLS + column grants). All writes go through
    SECURITY DEFINER RPCs (owner only) or the service role (edge function).
  - Ingest keys are stored as SHA-256 hashes; the raw key is shown once.
  - Raw payloads may contain financial data, so reads are gated by the same
    owner / can_view_billing rule used elsewhere in Vireek.
  - Graph nodes only receive a whitelist of NON-financial fields.
  - Fully idempotent: safe to re-run.
*/

-- =============================================================
-- 0. Graph edges may now carry source = 'fabric'
--    (internal rebuilds only prune 'system' edges, so fabric links survive)
-- =============================================================

DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.service_graph_edges') IS NULL THEN
    RAISE EXCEPTION 'service_graph_edges is missing — apply the service graph migration first.';
  END IF;

  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.service_graph_edges'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%source%'
      AND pg_get_constraintdef(oid) ILIKE '%staff%'
  LOOP
    EXECUTE format('ALTER TABLE public.service_graph_edges DROP CONSTRAINT %I', r.conname);
  END LOOP;

  ALTER TABLE public.service_graph_edges
    ADD CONSTRAINT service_graph_edges_source_check
    CHECK (source IN ('system', 'staff', 'ai', 'fabric'));
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- =============================================================
-- 1. Access helper (owner, or team member with can_view_billing)
-- =============================================================

CREATE OR REPLACE FUNCTION public.fabric_can_view(p_owner uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth.uid() = p_owner
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      WHERE tm.account_owner_id = p_owner
        AND lower(tm.member_email) = lower((SELECT email FROM auth.users WHERE id = auth.uid()))
        AND COALESCE((tm.permissions ->> 'can_view_billing')::boolean, false)
    );
$$;

REVOKE ALL ON FUNCTION public.fabric_can_view(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fabric_can_view(uuid) TO authenticated;

-- =============================================================
-- 2. Tables
-- =============================================================

CREATE TABLE IF NOT EXISTS fabric_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  connector_key text NOT NULL CHECK (connector_key ~ '^[a-z0-9_]{2,40}$'),
  domain text NOT NULL CHECK (domain IN (
    'crm', 'erp', 'accounting', 'oem', 'iot', 'telematics', 'maps', 'payments',
    'inventory', 'phone', 'email', 'calendar', 'insurance', 'warranty',
    'government', 'marketplace'
  )),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  entities text[] NOT NULL DEFAULT ARRAY[]::text[],
  field_mapping jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(field_mapping) = 'object'),
  ingest_key_hash text NOT NULL UNIQUE,
  ingest_key_prefix text NOT NULL,
  last_event_at timestamptz,
  last_error text,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fabric_connections_user ON fabric_connections(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fabric_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES fabric_connections(id) ON DELETE CASCADE,
  entity text NOT NULL CHECK (entity IN (
    'customer', 'property', 'equipment', 'technician', 'part', 'job',
    'vendor', 'payment', 'call', 'warranty'
  )),
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  payload_hash text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(refs) = 'array'),
  occurred_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'failed', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  node_id uuid REFERENCES service_graph_nodes(id) ON DELETE SET NULL,
  match_method text,
  match_confidence numeric(4, 3),
  received_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  UNIQUE (connection_id, entity, external_id)
);

CREATE INDEX IF NOT EXISTS idx_fabric_records_user_status ON fabric_records(user_id, status);
CREATE INDEX IF NOT EXISTS idx_fabric_records_conn_received ON fabric_records(connection_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_fabric_records_node ON fabric_records(node_id) WHERE node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fabric_records_refs ON fabric_records USING gin (refs jsonb_path_ops);

-- =============================================================
-- 3. RLS + grants (read-only for clients)
-- =============================================================

ALTER TABLE fabric_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE fabric_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_fabric_connections" ON fabric_connections;
CREATE POLICY "select_fabric_connections" ON fabric_connections
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.fabric_can_view(user_id));

DROP POLICY IF EXISTS "select_fabric_records" ON fabric_records;
CREATE POLICY "select_fabric_records" ON fabric_records
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.fabric_can_view(user_id));

REVOKE ALL ON fabric_connections FROM anon, authenticated;
GRANT SELECT (
  id, user_id, connector_key, domain, name, status, entities, field_mapping,
  ingest_key_prefix, last_event_at, last_error, created_at, updated_at
) ON fabric_connections TO authenticated;

REVOKE ALL ON fabric_records FROM anon, authenticated;
GRANT SELECT ON fabric_records TO authenticated;

-- =============================================================
-- 4. Pure helpers
-- =============================================================

CREATE OR REPLACE FUNCTION public._fabric_digits(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN length(regexp_replace(COALESCE(p, ''), '\D', '', 'g')) >= 7
      THEN right(regexp_replace(COALESCE(p, ''), '\D', '', 'g'), 10)
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public._fabric_label(p_entity text, p_external text, d jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT left(COALESCE(
    NULLIF(btrim(d->>'name'), ''),
    NULLIF(btrim(d->>'title'), ''),
    NULLIF(btrim(d->>'label'), ''),
    NULLIF(concat_ws(' · ', NULLIF(btrim(d->>'make'), ''), NULLIF(btrim(d->>'model'), '')), ''),
    NULLIF(btrim(d->>'address'), ''),
    initcap(p_entity) || ' ' || p_external
  ), 200);
$$;

-- Whitelist of NON-financial, scalar fields that may appear on graph nodes.
CREATE OR REPLACE FUNCTION public._fabric_props(d jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_object_agg(
      t.k,
      CASE WHEN jsonb_typeof(t.v) = 'string' THEN to_jsonb(left(t.v #>> '{}', 300)) ELSE t.v END
    ),
    '{}'::jsonb
  )
  FROM jsonb_each(d) AS t(k, v)
  WHERE t.k = ANY (ARRAY[
    'kind', 'status', 'name', 'email', 'phone', 'address', 'city', 'region',
    'postal_code', 'country', 'make', 'model', 'serial_number', 'install_date',
    'warranty_expires_at', 'category', 'sku', 'vendor', 'provider',
    'policy_number', 'coverage_type', 'valid_until', 'direction', 'channel',
    'duration_seconds', 'scheduled_at', 'completed_at', 'priority', 'currency'
  ])
  AND jsonb_typeof(t.v) IN ('string', 'number', 'boolean');
$$;

-- Default relation + direction between two canonical entities.
-- Names mirror the relations the core service graph already uses.
CREATE OR REPLACE FUNCTION public._fabric_edge_rule(
  p_this text, p_other text, OUT relation text, OUT this_is_from boolean
)
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  relation := 'related_to';
  this_is_from := true;
  CASE p_this || '>' || p_other
    WHEN 'job>customer'       THEN relation := 'requested';       this_is_from := false;
    WHEN 'job>property'       THEN relation := 'performed_at';
    WHEN 'job>technician'     THEN relation := 'handled_by';
    WHEN 'job>equipment'      THEN relation := 'serviced';
    WHEN 'job>payment'        THEN relation := 'billed_as';
    WHEN 'job>part'           THEN relation := 'used_part';
    WHEN 'job>call'           THEN relation := 'originated';      this_is_from := false;
    WHEN 'equipment>customer' THEN relation := 'owns_equipment';  this_is_from := false;
    WHEN 'equipment>property' THEN relation := 'has_equipment';   this_is_from := false;
    WHEN 'equipment>warranty' THEN relation := 'covered_by';
    WHEN 'customer>property'  THEN relation := 'has_property';
    WHEN 'customer>equipment' THEN relation := 'owns_equipment';
    WHEN 'property>customer'  THEN relation := 'has_property';    this_is_from := false;
    WHEN 'property>equipment' THEN relation := 'has_equipment';
    WHEN 'payment>job'        THEN relation := 'billed_as';       this_is_from := false;
    WHEN 'call>job'           THEN relation := 'originated';
    WHEN 'warranty>equipment' THEN relation := 'covered_by';      this_is_from := false;
    WHEN 'technician>job'     THEN relation := 'handled_by';      this_is_from := false;
    WHEN 'part>job'           THEN relation := 'used_part';       this_is_from := false;
    ELSE NULL;
  END CASE;
END;
$$;

-- =============================================================
-- 5. Graph projection (internal)
-- =============================================================

CREATE OR REPLACE FUNCTION public._fabric_link(
  p_user uuid, p_this_node uuid, p_this_entity text,
  p_other_node uuid, p_other_entity text,
  p_relation text, p_connector text, p_record uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rel text;
  v_from boolean;
  v_ev jsonb;
BEGIN
  IF p_this_node IS NULL OR p_other_node IS NULL OR p_this_node = p_other_node THEN
    RETURN;
  END IF;

  SELECT r.relation, r.this_is_from INTO v_rel, v_from
  FROM public._fabric_edge_rule(p_this_entity, p_other_entity) r;

  IF p_relation IS NOT NULL AND p_relation ~ '^[a-z_]{2,40}$' THEN
    v_rel := p_relation;
  END IF;

  v_ev := jsonb_build_object('fabric', jsonb_build_object('connector', p_connector, 'record', p_record));

  IF v_from THEN
    PERFORM public._sg_edge(p_user, p_this_node, p_other_node, v_rel, 'fabric', v_ev);
  ELSE
    PERFORM public._sg_edge(p_user, p_other_node, p_this_node, v_rel, 'fabric', v_ev);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._fabric_apply_core(p_record_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r fabric_records%ROWTYPE;
  c fabric_connections%ROWTYPE;
  v_key text;
  v_method text := 'external_id';
  v_conf numeric := 1.0;
  v_id uuid;
  v_props jsonb;
  v_label text;
  v_addr text;
  v_prop uuid;
  v_email text;
  v_phone text;
  v_serial text;
  v_found text;
  v_unresolved integer := 0;
  v_ref jsonb;
  v_target uuid;
  rec2 record;
BEGIN
  SELECT * INTO r FROM fabric_records WHERE id = p_record_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;

  SELECT * INTO c FROM fabric_connections WHERE id = r.connection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Connection no longer exists';
  END IF;

  v_label := public._fabric_label(r.entity, r.external_id, r.data);
  v_props := public._fabric_props(r.data);
  v_addr := public._sg_norm_address(r.data->>'address');

  -- ---- Identity resolution ------------------------------------------------
  IF r.node_id IS NOT NULL THEN
    SELECT node_key INTO v_key FROM service_graph_nodes WHERE id = r.node_id;
    IF v_key IS NOT NULL THEN
      v_method := COALESCE(r.match_method, 'link');
      v_conf := COALESCE(r.match_confidence, 1.0);
    END IF;
  END IF;

  IF v_key IS NULL AND r.entity = 'customer' THEN
    v_email := NULLIF(lower(btrim(COALESCE(r.data->>'email', ''))), '');
    v_phone := public._fabric_digits(r.data->>'phone');
    BEGIN
      IF v_email IS NOT NULL THEN
        EXECUTE $q$
          SELECT x.id::text FROM customers x
          WHERE x.user_id = $1
            AND lower(btrim(COALESCE(to_jsonb(x)->>'email', ''))) = $2
          LIMIT 1
        $q$ INTO v_found USING r.user_id, v_email;
        IF v_found IS NOT NULL THEN
          v_key := v_found; v_method := 'email'; v_conf := 0.95;
        END IF;
      END IF;
      IF v_key IS NULL AND v_phone IS NOT NULL THEN
        EXECUTE $q$
          SELECT x.id::text FROM customers x
          WHERE x.user_id = $1
            AND right(regexp_replace(COALESCE(to_jsonb(x)->>'phone', ''), '\D', '', 'g'), 10) = $2
          LIMIT 1
        $q$ INTO v_found USING r.user_id, v_phone;
        IF v_found IS NOT NULL THEN
          v_key := v_found; v_method := 'phone'; v_conf := 0.90;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_key := NULL;
    END;
  END IF;

  IF v_key IS NULL AND r.entity = 'equipment' THEN
    v_serial := NULLIF(upper(btrim(COALESCE(r.data->>'serial_number', ''))), '');
    IF v_serial IS NOT NULL THEN
      BEGIN
        EXECUTE $q$
          SELECT x.id::text FROM equipment x
          WHERE x.user_id = $1
            AND upper(btrim(COALESCE(to_jsonb(x)->>'serial_number', ''))) = $2
          LIMIT 1
        $q$ INTO v_found USING r.user_id, v_serial;
        IF v_found IS NOT NULL THEN
          v_key := v_found; v_method := 'serial'; v_conf := 0.97;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_key := NULL;
      END;
    END IF;
  END IF;

  IF v_key IS NULL AND r.entity = 'property' AND v_addr IS NOT NULL THEN
    v_key := v_addr; v_method := 'address'; v_conf := 0.90;
  END IF;

  IF v_key IS NULL THEN
    v_key := 'fx:' || left(c.id::text, 8) || ':' || r.external_id;
    v_method := 'external_id';
    v_conf := 1.0;
  END IF;

  -- ---- Node upsert (internally-owned nodes are never overwritten) ---------
  v_id := public._sg_find(r.user_id, r.entity, v_key);
  IF v_id IS NULL THEN
    v_id := public._sg_node(r.user_id, r.entity, v_key, v_label, v_props);
  ELSIF v_method IN ('email', 'phone', 'serial', 'address') THEN
    UPDATE service_graph_nodes
      SET properties = v_props || properties, updated_at = now()
      WHERE id = v_id;
  ELSE
    v_id := public._sg_node(r.user_id, r.entity, v_key, v_label, v_props);
  END IF;

  -- Provenance: which systems vouch for this node.
  UPDATE service_graph_nodes
    SET properties = jsonb_set(
      properties,
      '{fabric_sources}',
      COALESCE(properties->'fabric_sources', '{}'::jsonb) || jsonb_build_object(
        c.connector_key || ':' || left(c.id::text, 8),
        jsonb_build_object(
          'domain', c.domain,
          'external_id', r.external_id,
          'confidence', v_conf,
          'seen_at', now()
        )
      ),
      true
    )
    WHERE id = v_id;

  -- ---- Address → property edge -------------------------------------------
  IF v_addr IS NOT NULL AND r.entity IN ('customer', 'job', 'equipment') THEN
    v_prop := public._sg_find(r.user_id, 'property', v_addr);
    IF v_prop IS NULL THEN
      v_prop := public._sg_node(r.user_id, 'property', v_addr, left(btrim(r.data->>'address'), 200), '{}'::jsonb);
    END IF;
    PERFORM public._fabric_link(r.user_id, v_id, r.entity, v_prop, 'property', NULL, c.connector_key, r.id);
  END IF;

  -- ---- Explicit references to other records of the same connection -------
  FOR v_ref IN SELECT e FROM jsonb_array_elements(r.refs) AS e LIMIT 25 LOOP
    SELECT f.node_id INTO v_target
    FROM fabric_records f
    WHERE f.connection_id = r.connection_id
      AND f.entity = v_ref->>'entity'
      AND f.external_id = v_ref->>'external_id'
      AND f.node_id IS NOT NULL;

    IF v_target IS NULL THEN
      v_unresolved := v_unresolved + 1;
    ELSE
      PERFORM public._fabric_link(
        r.user_id, v_id, r.entity, v_target, v_ref->>'entity',
        v_ref->>'relation', c.connector_key, r.id
      );
    END IF;
  END LOOP;

  -- ---- Back-fill: earlier records that referenced this one ----------------
  FOR rec2 IN
    SELECT f.id AS rid, f.node_id AS nid, f.entity AS ent, e->>'relation' AS relation
    FROM fabric_records f,
         LATERAL jsonb_array_elements(f.refs) AS e
    WHERE f.connection_id = r.connection_id
      AND f.id <> r.id
      AND f.node_id IS NOT NULL
      AND f.refs @> jsonb_build_array(jsonb_build_object('entity', r.entity, 'external_id', r.external_id))
      AND e->>'entity' = r.entity
      AND e->>'external_id' = r.external_id
    LIMIT 200
  LOOP
    PERFORM public._fabric_link(r.user_id, rec2.nid, rec2.ent, v_id, r.entity, rec2.relation, c.connector_key, rec2.rid);
  END LOOP;

  UPDATE fabric_records
    SET node_id = v_id,
        status = 'applied',
        error = NULL,
        match_method = v_method,
        match_confidence = v_conf,
        applied_at = now()
    WHERE id = r.id;

  RETURN jsonb_build_object(
    'status', 'applied',
    'node_id', v_id,
    'match_method', v_method,
    'unresolved_refs', v_unresolved
  );
END;
$$;

-- Public entry point used by the edge function: never raises, records failures.
CREATE OR REPLACE FUNCTION public.fabric_apply_record(p_record_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    RETURN public._fabric_apply_core(p_record_id);
  EXCEPTION WHEN OTHERS THEN
    UPDATE fabric_records
      SET attempts = attempts + 1,
          status = CASE WHEN attempts + 1 >= 5 THEN 'dead_letter' ELSE 'failed' END,
          error = left(SQLERRM, 500)
      WHERE id = p_record_id;
    RETURN jsonb_build_object('status', 'failed', 'error', left(SQLERRM, 300));
  END;
END;
$$;

-- =============================================================
-- 6. Owner-only management RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public._fabric_require_owner()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can manage data connections.' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;

CREATE OR REPLACE FUNCTION public._fabric_new_key()
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT 'vfk_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
$$;

CREATE OR REPLACE FUNCTION public.fabric_create_connection(
  p_connector_key text,
  p_domain text,
  p_name text,
  p_entities text[] DEFAULT NULL,
  p_field_mapping jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (connection_id uuid, ingest_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._fabric_require_owner();
  v_all text[] := ARRAY['customer', 'property', 'equipment', 'technician', 'part', 'job', 'vendor', 'payment', 'call', 'warranty'];
  v_entities text[];
  v_key text;
  v_id uuid;
BEGIN
  v_entities := COALESCE(NULLIF(p_entities, ARRAY[]::text[]), v_all);
  IF NOT (v_entities <@ v_all) THEN
    RAISE EXCEPTION 'Unknown entity in list.';
  END IF;
  IF p_field_mapping IS NULL OR jsonb_typeof(p_field_mapping) <> 'object' OR length(p_field_mapping::text) > 20000 THEN
    RAISE EXCEPTION 'Field mapping must be a JSON object under 20 KB.';
  END IF;
  IF (SELECT count(*) FROM fabric_connections WHERE user_id = v_owner) >= 50 THEN
    RAISE EXCEPTION 'Connection limit reached (50).';
  END IF;

  v_key := public._fabric_new_key();

  INSERT INTO fabric_connections (
    user_id, connector_key, domain, name, entities, field_mapping, ingest_key_hash, ingest_key_prefix
  ) VALUES (
    v_owner, p_connector_key, p_domain, btrim(p_name), v_entities, p_field_mapping,
    encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), left(v_key, 12)
  )
  RETURNING id INTO v_id;

  connection_id := v_id;
  ingest_key := v_key;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.fabric_rotate_key(p_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._fabric_require_owner();
  v_key text := public._fabric_new_key();
BEGIN
  UPDATE fabric_connections
    SET ingest_key_hash = encode(sha256(convert_to(v_key, 'UTF8')), 'hex'),
        ingest_key_prefix = left(v_key, 12),
        updated_at = now()
    WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Connection not found.';
  END IF;
  RETURN v_key;
END;
$$;

CREATE OR REPLACE FUNCTION public.fabric_update_connection(
  p_id uuid,
  p_name text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_entities text[] DEFAULT NULL,
  p_field_mapping jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._fabric_require_owner();
  v_all text[] := ARRAY['customer', 'property', 'equipment', 'technician', 'part', 'job', 'vendor', 'payment', 'call', 'warranty'];
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('active', 'paused') THEN
    RAISE EXCEPTION 'Invalid status.';
  END IF;
  IF p_entities IS NOT NULL AND NOT (p_entities <@ v_all) THEN
    RAISE EXCEPTION 'Unknown entity in list.';
  END IF;
  IF p_field_mapping IS NOT NULL AND (jsonb_typeof(p_field_mapping) <> 'object' OR length(p_field_mapping::text) > 20000) THEN
    RAISE EXCEPTION 'Field mapping must be a JSON object under 20 KB.';
  END IF;

  UPDATE fabric_connections
    SET name = COALESCE(NULLIF(btrim(p_name), ''), name),
        status = COALESCE(p_status, status),
        entities = COALESCE(NULLIF(p_entities, ARRAY[]::text[]), entities),
        field_mapping = COALESCE(p_field_mapping, field_mapping),
        updated_at = now()
    WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Connection not found.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fabric_delete_connection(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._fabric_require_owner();
BEGIN
  DELETE FROM fabric_connections WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Connection not found.';
  END IF;
END;
$$;

-- Re-run failed / dead-lettered records (e.g. after fixing a mapping).
CREATE OR REPLACE FUNCTION public.fabric_reapply_failed(p_connection_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._fabric_require_owner();
  v_id uuid;
  v_res jsonb;
  v_retried integer := 0;
  v_applied integer := 0;
BEGIN
  FOR v_id IN
    SELECT id FROM fabric_records
    WHERE user_id = v_owner
      AND status IN ('failed', 'dead_letter')
      AND (p_connection_id IS NULL OR connection_id = p_connection_id)
    ORDER BY received_at
    LIMIT 200
  LOOP
    UPDATE fabric_records SET status = 'pending', attempts = 0 WHERE id = v_id;
    v_res := public.fabric_apply_record(v_id);
    v_retried := v_retried + 1;
    IF v_res->>'status' = 'applied' THEN
      v_applied := v_applied + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('retried', v_retried, 'applied', v_applied, 'failed', v_retried - v_applied);
END;
$$;

CREATE OR REPLACE FUNCTION public.fabric_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.fabric_can_view(v_owner) THEN
    RAISE EXCEPTION 'Not allowed.' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'connections', (SELECT count(*) FROM fabric_connections WHERE user_id = v_owner),
    'active_connections', (SELECT count(*) FROM fabric_connections WHERE user_id = v_owner AND status = 'active'),
    'records_total', (SELECT count(*) FROM fabric_records WHERE user_id = v_owner),
    'records_24h', (SELECT count(*) FROM fabric_records WHERE user_id = v_owner AND received_at > now() - interval '24 hours'),
    'applied', (SELECT count(*) FROM fabric_records WHERE user_id = v_owner AND status = 'applied'),
    'pending', (SELECT count(*) FROM fabric_records WHERE user_id = v_owner AND status = 'pending'),
    'failed', (SELECT count(*) FROM fabric_records WHERE user_id = v_owner AND status = 'failed'),
    'dead_letter', (SELECT count(*) FROM fabric_records WHERE user_id = v_owner AND status = 'dead_letter'),
    'linked_nodes', (SELECT count(DISTINCT node_id) FROM fabric_records WHERE user_id = v_owner AND node_id IS NOT NULL),
    'multi_source_nodes', (
      SELECT count(*) FROM service_graph_nodes n
      WHERE n.user_id = v_owner
        AND jsonb_typeof(n.properties->'fabric_sources') = 'object'
        AND (SELECT count(*) FROM jsonb_object_keys(n.properties->'fabric_sources')) > 1
    ),
    'by_connection', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'connection_id', t.connection_id,
        'records', t.n,
        'failed', t.f,
        'last_received', t.m
      )), '[]'::jsonb)
      FROM (
        SELECT connection_id,
               count(*) AS n,
               count(*) FILTER (WHERE status IN ('failed', 'dead_letter')) AS f,
               max(received_at) AS m
        FROM fabric_records
        WHERE user_id = v_owner
        GROUP BY connection_id
      ) t
    )
  );
END;
$$;

-- =============================================================
-- 7. Function privileges
-- =============================================================

REVOKE ALL ON FUNCTION public._fabric_link(uuid, uuid, text, uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fabric_apply_core(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fabric_apply_record(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fabric_require_owner() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fabric_new_key() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fabric_apply_record(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fabric_create_connection(text, text, text, text[], jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fabric_rotate_key(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fabric_update_connection(uuid, text, text, text[], jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fabric_delete_connection(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fabric_reapply_failed(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fabric_overview() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fabric_create_connection(text, text, text, text[], jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fabric_rotate_key(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fabric_update_connection(uuid, text, text, text[], jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fabric_delete_connection(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fabric_reapply_failed(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fabric_overview() TO authenticated;
