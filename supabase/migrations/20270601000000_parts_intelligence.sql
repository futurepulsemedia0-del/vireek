/*
  # Parts Intelligence — read model on top of existing data (NO new tables)

  Extends AI Parts Market with compatibility, substitutions, recall signals and demand
  signals by JOINING data that already exists:

    inventory_parts / inventory_stock_levels / inventory_transactions   (Inventory)
    inventory_part_substitutes / parts_market_live_offers               (Inventory + Parts Market)
    job_parts_required / jobs                                           (scheduled demand)
    oem_parts / oem_issue_parts / oem_known_issues / oem_recalls /
    oem_service_bulletins / oem_equipment_models / equipment_oem_link   (OEM Intelligence)

  Failure history, pricing, sourcing and install outcomes are read client-side from the
  existing tables/views (equipment_failure_events, get_failure_pattern_exposure,
  parts_market_*, supply_chain_install_outcomes) — nothing is copied or duplicated.

  Both functions are SECURITY INVOKER: the caller's own RLS applies to every table, exactly
  like get_oem_graph_for_equipment(). Reference-layer OEM tables are read-only for everyone.

  Matching rule (honest by design): an inventory part is linked to an OEM part ONLY when the
  normalised part numbers are equal (case, spaces, dashes and punctuation ignored). Nothing
  is guessed from names. Parts without a part number simply have no OEM link.

  Additive + idempotent (safe to re-run).
*/

-- ---------------------------------------------------------------
-- Helper: normalise a part number for equality matching
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pi_norm(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '', 'g'), '');
$$;

-- ---------------------------------------------------------------
-- 1) OVERVIEW: one compact row per active part
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_parts_intelligence_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_out jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'PARTS_INTEL_UNAUTHORIZED' USING ERRCODE = 'P0001';
  END IF;

  WITH p AS (
    SELECT id, name, part_number, category, unit_cost_cents, reorder_point, reorder_quantity,
           public.pi_norm(part_number) AS pn
    FROM inventory_parts
    WHERE active = true
    ORDER BY name
    LIMIT 2000
  ),
  stock AS (
    SELECT sl.part_id,
           sum(sl.quantity_on_hand)::int AS on_hand,
           sum(sl.quantity_on_hand - sl.quantity_reserved)::int AS available
    FROM inventory_stock_levels sl
    JOIN inventory_locations loc ON loc.id = sl.location_id AND loc.active = true
    GROUP BY sl.part_id
  ),
  usage AS (
    SELECT t.part_id,
           ((current_date - t.created_at::date) / 7) AS wk,
           sum(-t.quantity_delta)::int AS qty
    FROM inventory_transactions t
    WHERE t.transaction_type = 'usage'
      AND t.created_at >= now() - interval '91 days'
    GROUP BY t.part_id, ((current_date - t.created_at::date) / 7)
  ),
  scheduled AS (
    SELECT jpr.part_id, sum(jpr.quantity_required)::int AS qty
    FROM job_parts_required jpr
    JOIN jobs j ON j.id = jpr.job_id
    WHERE jpr.status IN ('needed', 'allocated', 'backordered')
      AND j.scheduled_datetime >= now()
      AND j.scheduled_datetime < now() + interval '30 days'
      AND lower(coalesce(j.job_status, '')) NOT IN ('cancelled', 'canceled')
    GROUP BY jpr.part_id
  ),
  oem AS (
    SELECT p.id AS part_id, op.id AS oem_part_id, op.manufacturer_id, op.model_id
    FROM p
    JOIN oem_parts op ON p.pn IS NOT NULL AND public.pi_norm(op.part_number) = p.pn
  ),
  units AS (
    SELECT o.part_id, count(DISTINCT l.equipment_id)::int AS n
    FROM oem o
    JOIN equipment_oem_link l
      ON (o.model_id IS NOT NULL AND l.model_id = o.model_id)
      OR (o.model_id IS NULL AND l.manufacturer_id = o.manufacturer_id)
    JOIN equipment e ON e.id = l.equipment_id AND e.status = 'active'
    GROUP BY o.part_id
  ),
  sig AS (
    SELECT o.part_id,
           count(DISTINCT i.id)::int AS issues,
           count(DISTINCT i.recall_id)::int AS recalls,
           count(DISTINCT i.bulletin_id)::int AS bulletins,
           max(CASE coalesce(r.severity, i.severity)
                 WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) AS sev_rank
    FROM oem o
    JOIN oem_issue_parts ip ON ip.part_id = o.oem_part_id
    JOIN oem_known_issues i ON i.id = ip.issue_id
    LEFT JOIN oem_recalls r ON r.id = i.recall_id
    GROUP BY o.part_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'part_id', p.id,
    'name', p.name,
    'part_number', p.part_number,
    'category', p.category,
    'unit_cost_cents', p.unit_cost_cents,
    'reorder_point', p.reorder_point,
    'reorder_quantity', p.reorder_quantity,
    'on_hand', coalesce(s.on_hand, 0),
    'available', coalesce(s.available, 0),
    -- oldest -> newest, 13 weekly buckets, zeros filled
    'weekly_usage', to_jsonb(ARRAY(
      SELECT coalesce((SELECT u.qty FROM usage u WHERE u.part_id = p.id AND u.wk = g.w), 0)
      FROM generate_series(12, 0, -1) AS g(w)
    )),
    'scheduled_30d', coalesce(sc.qty, 0),
    'oem_matched', EXISTS (SELECT 1 FROM oem o WHERE o.part_id = p.id),
    'compatible_units', coalesce(un.n, 0),
    'issue_count', coalesce(sg.issues, 0),
    'recall_count', coalesce(sg.recalls, 0),
    'bulletin_count', coalesce(sg.bulletins, 0),
    'max_severity', CASE sg.sev_rank WHEN 4 THEN 'critical' WHEN 3 THEN 'high' WHEN 2 THEN 'medium' WHEN 1 THEN 'low' ELSE NULL END
  ) ORDER BY p.name), '[]'::jsonb)
  INTO v_out
  FROM p
  LEFT JOIN stock s ON s.part_id = p.id
  LEFT JOIN scheduled sc ON sc.part_id = p.id
  LEFT JOIN units un ON un.part_id = p.id
  LEFT JOIN sig sg ON sg.part_id = p.id;

  RETURN v_out;
END;
$$;

-- ---------------------------------------------------------------
-- 2) DETAIL: compatibility, substitutions, recall signals for ONE part
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_parts_intelligence_detail(p_part_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_part record;
  v_pn text;
  v_oem jsonb;
  v_models jsonb;
  v_units jsonb;
  v_issues jsonb;
  v_model_recalls jsonb;
  v_model_bulletins jsonb;
  v_subs jsonb;
  v_subs_for jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'PARTS_INTEL_UNAUTHORIZED' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, name, part_number, category, unit_cost_cents INTO v_part
  FROM inventory_parts WHERE id = p_part_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;

  v_pn := public.pi_norm(v_part.part_number);

  -- Matched OEM catalogue entries (exact normalised part-number equality only)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'oem_part_id', op.id, 'part_number', op.part_number, 'part_name', op.part_name,
           'avg_price_cents', CASE WHEN op.avg_price IS NULL THEN NULL ELSE round(op.avg_price * 100)::int END,
           'manufacturer', m.name, 'manufacturer_id', m.id,
           'model_id', op.model_id, 'model_number', em.model_number, 'equipment_type', em.equipment_type
         ) ORDER BY m.name, em.model_number NULLS FIRST), '[]'::jsonb)
  INTO v_oem
  FROM oem_parts op
  JOIN oem_manufacturers m ON m.id = op.manufacturer_id
  LEFT JOIN oem_equipment_models em ON em.id = op.model_id
  WHERE v_pn IS NOT NULL AND public.pi_norm(op.part_number) = v_pn;

  -- Compatible models actually present in MY fleet (model-scoped OEM parts)
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.n DESC, x.label), '[]'::jsonb) INTO v_models
  FROM (
    SELECT count(DISTINCT e.id)::int AS n,
           (m.name || ' ' || em.model_number) AS label,
           jsonb_build_object(
             'model_id', em.id, 'manufacturer', m.name, 'model_number', em.model_number,
             'equipment_type', em.equipment_type,
             'my_units', count(DISTINCT e.id)::int) AS j
    FROM oem_parts op
    JOIN oem_equipment_models em ON em.id = op.model_id
    JOIN oem_manufacturers m ON m.id = em.manufacturer_id
    LEFT JOIN equipment_oem_link l ON l.model_id = em.id
    LEFT JOIN equipment e ON e.id = l.equipment_id AND e.status = 'active'
    WHERE v_pn IS NOT NULL AND public.pi_norm(op.part_number) = v_pn AND op.model_id IS NOT NULL
    GROUP BY em.id, m.name, em.model_number, em.equipment_type
    LIMIT 40
  ) x;

  -- My units this part fits (model match, or manufacturer-wide part), capped
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'equipment_id', u.id, 'make', u.make, 'model', u.model, 'equipment_type', u.equipment_type,
           'install_date', u.install_date, 'customer_name', u.customer_name)
         ORDER BY u.install_date NULLS LAST), '[]'::jsonb)
  INTO v_units
  FROM (
    SELECT DISTINCT e.id, e.make, e.model, e.equipment_type, e.install_date, c.name AS customer_name
    FROM oem_parts op
    JOIN equipment_oem_link l
      ON (op.model_id IS NOT NULL AND l.model_id = op.model_id)
      OR (op.model_id IS NULL AND l.manufacturer_id = op.manufacturer_id)
    JOIN equipment e ON e.id = l.equipment_id AND e.status = 'active'
    LEFT JOIN customers c ON c.id = e.customer_id
    WHERE v_pn IS NOT NULL AND public.pi_norm(op.part_number) = v_pn
    LIMIT 60
  ) u;

  -- Known issues that REQUIRE this part, with their recall / bulletin
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'issue_id', i.id, 'title', i.title, 'severity', i.severity, 'symptom', i.symptom,
           'recommended_repair', i.recommended_repair, 'quantity', ip.quantity, 'is_required', ip.is_required,
           'manufacturer', m.name, 'source_url', i.source_url,
           'recall', (SELECT jsonb_build_object('recall_number', r.recall_number, 'title', r.title,
                        'severity', r.severity, 'issued_date', r.issued_date, 'remedy', r.remedy, 'source_url', r.source_url)
                      FROM oem_recalls r WHERE r.id = i.recall_id),
           'bulletin', (SELECT jsonb_build_object('bulletin_number', b.bulletin_number, 'title', b.title,
                         'issued_date', b.issued_date, 'source_url', b.source_url)
                       FROM oem_service_bulletins b WHERE b.id = i.bulletin_id)
         ) ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, i.title), '[]'::jsonb)
  INTO v_issues
  FROM oem_parts op
  JOIN oem_issue_parts ip ON ip.part_id = op.id
  JOIN oem_known_issues i ON i.id = ip.issue_id
  JOIN oem_manufacturers m ON m.id = i.manufacturer_id
  WHERE v_pn IS NOT NULL AND public.pi_norm(op.part_number) = v_pn;

  -- Model-level context (NOT part-specific): recalls / bulletins on models this part fits
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'recall_number', r.recall_number, 'title', r.title, 'severity', r.severity,
           'issued_date', r.issued_date, 'model_number', em.model_number, 'source_url', r.source_url)
         ORDER BY r.issued_date DESC NULLS LAST), '[]'::jsonb)
  INTO v_model_recalls
  FROM (
    SELECT DISTINCT op.model_id FROM oem_parts op
    WHERE v_pn IS NOT NULL AND public.pi_norm(op.part_number) = v_pn AND op.model_id IS NOT NULL
  ) mm
  JOIN oem_equipment_models em ON em.id = mm.model_id
  JOIN oem_recalls r ON r.model_id = mm.model_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'bulletin_number', b.bulletin_number, 'title', b.title, 'issued_date', b.issued_date,
           'model_number', em.model_number, 'source_url', b.source_url)
         ORDER BY b.issued_date DESC NULLS LAST), '[]'::jsonb)
  INTO v_model_bulletins
  FROM (
    SELECT DISTINCT op.model_id FROM oem_parts op
    WHERE v_pn IS NOT NULL AND public.pi_norm(op.part_number) = v_pn AND op.model_id IS NOT NULL
  ) mm
  JOIN oem_equipment_models em ON em.id = mm.model_id
  JOIN oem_service_bulletins b ON b.model_id = mm.model_id;

  -- Substitutes: parts that can stand in for THIS part (direction as stored)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'part_id', sp.id, 'name', sp.name, 'part_number', sp.part_number, 'note', s.note,
           'unit_cost_cents', sp.unit_cost_cents,
           'available', coalesce((SELECT sum(sl.quantity_on_hand - sl.quantity_reserved)::int
                                  FROM inventory_stock_levels sl
                                  JOIN inventory_locations loc ON loc.id = sl.location_id AND loc.active = true
                                  WHERE sl.part_id = sp.id), 0),
           'best_offer_cents', (SELECT min(o.unit_price_cents) FROM parts_market_live_offers o
                                WHERE o.part_id = sp.id AND o.source_active AND NOT o.is_expired AND o.quantity_available > 0)
         ) ORDER BY sp.name), '[]'::jsonb)
  INTO v_subs
  FROM inventory_part_substitutes s
  JOIN inventory_parts sp ON sp.id = s.substitute_part_id AND sp.active = true
  WHERE s.part_id = p_part_id;

  -- Reverse direction: parts THIS part can stand in for
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'part_id', op2.id, 'name', op2.name, 'part_number', op2.part_number, 'note', s.note,
           'unit_cost_cents', op2.unit_cost_cents) ORDER BY op2.name), '[]'::jsonb)
  INTO v_subs_for
  FROM inventory_part_substitutes s
  JOIN inventory_parts op2 ON op2.id = s.part_id AND op2.active = true
  WHERE s.substitute_part_id = p_part_id;

  RETURN jsonb_build_object(
    'found', true,
    'part', jsonb_build_object('id', v_part.id, 'name', v_part.name, 'part_number', v_part.part_number,
                               'category', v_part.category, 'unit_cost_cents', v_part.unit_cost_cents),
    'has_part_number', v_pn IS NOT NULL,
    'oem_parts', v_oem,
    'models', v_models,
    'units', v_units,
    'issues', v_issues,
    'model_recalls', v_model_recalls,
    'model_bulletins', v_model_bulletins,
    'substitutes', v_subs,
    'substitute_for', v_subs_for
  );
END;
$$;

-- ---------------------------------------------------------------
-- Privileges: signed-in users only (RLS still applies inside)
-- ---------------------------------------------------------------
REVOKE ALL ON FUNCTION public.get_parts_intelligence_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_parts_intelligence_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_parts_intelligence_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_parts_intelligence_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pi_norm(text) TO authenticated;

COMMENT ON FUNCTION public.get_parts_intelligence_overview() IS
  'Parts Intelligence portfolio rows: stock, 13-week usage, scheduled demand, OEM link, recall/bulletin counts. SECURITY INVOKER.';
COMMENT ON FUNCTION public.get_parts_intelligence_detail(uuid) IS
  'Parts Intelligence detail for one part: OEM compatibility, my units, issues/recalls, substitutes. SECURITY INVOKER.';
