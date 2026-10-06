-- =============================================================
-- FIELD FORM TEMPLATES (offline checklists / forms for technicians)
-- System templates (owner_id IS NULL) are seeded below; an account owner can add their own,
-- or override a system template by creating one with the same slug.
-- Technicians cache them on the device through get_field_form_templates().
-- Depends on: 20261212000000_technician_mobile_os.sql (get_account_owner_id)
-- =============================================================

CREATE TABLE IF NOT EXISTS field_form_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9_]{2,60}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  description text CHECK (description IS NULL OR length(description) <= 500),
  trade text CHECK (trade IS NULL OR trade IN ('hvac', 'plumbing', 'electrical', 'general')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  schema jsonb NOT NULL CHECK (jsonb_typeof(schema -> 'fields') = 'array'),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_field_form_templates
  ON field_form_templates (COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), slug, version);

ALTER TABLE field_form_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_field_form_templates" ON field_form_templates;
CREATE POLICY "select_field_form_templates" ON field_form_templates FOR SELECT TO authenticated
USING (owner_id IS NULL OR owner_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "owner_insert_field_form_templates" ON field_form_templates;
CREATE POLICY "owner_insert_field_form_templates" ON field_form_templates FOR INSERT TO authenticated
WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "owner_update_field_form_templates" ON field_form_templates;
CREATE POLICY "owner_update_field_form_templates" ON field_form_templates FOR UPDATE TO authenticated
USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "owner_delete_field_form_templates" ON field_form_templates;
CREATE POLICY "owner_delete_field_form_templates" ON field_form_templates FOR DELETE TO authenticated
USING (owner_id = auth.uid());

-- ------------------------------------------------------------
-- RPC: templates visible to the caller. An owner's template wins over a system template
-- with the same slug; the highest active version wins.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_field_form_templates()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH visible AS (
    SELECT DISTINCT ON (t.slug) t.*
      FROM field_form_templates t
     WHERE t.is_active
       AND (t.owner_id IS NULL OR t.owner_id = public.get_account_owner_id())
     ORDER BY t.slug, (t.owner_id IS NOT NULL) DESC, t.version DESC
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', v.id, 'slug', v.slug, 'title', v.title, 'description', v.description,
        'trade', v.trade, 'version', v.version, 'schema', v.schema
      ) ORDER BY v.title
    ),
    '[]'::jsonb
  )
  FROM visible v;
$$;

GRANT EXECUTE ON FUNCTION public.get_field_form_templates() TO authenticated;

-- ------------------------------------------------------------
-- System templates (idempotent)
-- ------------------------------------------------------------
INSERT INTO field_form_templates (owner_id, slug, title, description, trade, version, schema) VALUES
(NULL, 'hvac_tuneup', 'HVAC tune-up report', 'Seasonal maintenance readings and findings.', 'hvac', 1,
 $json${"fields":[
  {"id":"system_type","type":"select","label":"System type","required":true,"options":["Split AC","Heat pump","Furnace","Package unit","Mini-split","Boiler"]},
  {"id":"filter_replaced","type":"checkbox","label":"Air filter replaced / cleaned","required":true},
  {"id":"coils_cleaned","type":"checkbox","label":"Coils inspected and cleaned"},
  {"id":"static_pressure","type":"number","label":"Total external static pressure (in. w.c.)"},
  {"id":"delta_t","type":"number","label":"Temperature split / delta-T (°F)","required":true},
  {"id":"refrigerant_ok","type":"yes_no","label":"Refrigerant charge within spec?","required":true},
  {"id":"electrical_ok","type":"yes_no","label":"Electrical connections tight, no burn marks?","required":true},
  {"id":"recommendations","type":"textarea","label":"Findings and recommendations"}
 ]}$json$::jsonb),
(NULL, 'plumbing_completion', 'Plumbing job completion', 'Pressure, leak and fixture checks before leaving.', 'plumbing', 1,
 $json${"fields":[
  {"id":"work_performed","type":"textarea","label":"Work performed","required":true},
  {"id":"leak_test","type":"yes_no","label":"Leak test passed?","required":true},
  {"id":"water_pressure","type":"number","label":"Static water pressure (psi)"},
  {"id":"shutoff_located","type":"checkbox","label":"Showed the customer the main shut-off","required":true},
  {"id":"permit_needed","type":"yes_no","label":"Permit required for this work?","required":true},
  {"id":"parts_used","type":"text","label":"Parts used"}
 ]}$json$::jsonb),
(NULL, 'electrical_safety', 'Electrical safety check', 'Panel and circuit safety verification.', 'electrical', 1,
 $json${"fields":[
  {"id":"panel_type","type":"text","label":"Panel make / amperage","required":true},
  {"id":"power_isolated","type":"checkbox","label":"Power isolated and verified dead before work","required":true},
  {"id":"gfci_afci_ok","type":"yes_no","label":"GFCI / AFCI protection tested and working?","required":true},
  {"id":"grounding_ok","type":"yes_no","label":"Grounding and bonding verified?","required":true},
  {"id":"issues_found","type":"textarea","label":"Issues found"},
  {"id":"inspection_needed","type":"yes_no","label":"Inspection required?","required":true}
 ]}$json$::jsonb)
ON CONFLICT DO NOTHING;
