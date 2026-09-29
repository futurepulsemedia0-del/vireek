/*
  # OEM Intelligence Network — Equipment Intelligence Graph

  Turns manufacturer relationships (Carrier, Trane, Lennox, Rheem, Goodman,
  Bosch, Daikin, ...) into a queryable graph sitting on top of the existing
  `equipment` table:

    Model -> Serial -> Parts -> Manuals -> Warranty -> Failure Patterns
           -> Recalls -> Service Bulletins

  ## Reference layer (shared across all accounts, NOT user-scoped)
  - oem_manufacturers      — the OEMs Vireek knows how to talk to
  - oem_equipment_models   — catalog: one row per make+model, spec sheet,
                              manual link, typical lifespan
  - oem_parts              — parts catalog, optionally scoped to a model
  - oem_recalls            — manufacturer recalls, optionally scoped to a
                              model
  - oem_service_bulletins  — manufacturer TSBs, optionally scoped to a
                              model
  - oem_failure_patterns   — failure modes computed in aggregate across
                              every account's job_equipment history for a
                              given model. This is the actual data-moat
                              table: no single account has enough repair
                              history on one model to see the pattern, but
                              Vireek does across all of them. Counts and a
                              failure-mode label only — never customer- or
                              account-identifying data.

  This reference layer is intentionally NOT user_id-scoped — it's shared
  knowledge every account should see. It is written only by the
  oem-graph-enrich edge function (service role); accounts can only read it.

  ## Per-account layer
  - equipment_oem_link   — links one of *your* `equipment` rows to the
                            graph (which manufacturer/model it matched, and
                            how confident that match is)
  - equipment_oem_alerts — recalls / bulletins / failure-pattern warnings
                            that apply to one of *your* units specifically.
                            Same idiom as equipment_maintenance_alerts from
                            20261012000000_equipment_lifecycle_intelligence.sql
*/

-- ---------- Reference layer (shared, service-role write only) ----------

CREATE TABLE IF NOT EXISTS oem_manufacturers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  logo_url text,
  support_url text,
  api_adapter text NOT NULL DEFAULT 'generic',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oem_equipment_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer_id uuid NOT NULL REFERENCES oem_manufacturers(id) ON DELETE CASCADE,
  model_number text NOT NULL,
  equipment_type text NOT NULL,
  category text,
  specs jsonb NOT NULL DEFAULT '{}'::jsonb,
  avg_lifespan_years integer,
  manual_url text,
  -- 'oem_api'  — fetched from a real manufacturer API (OEM_API_URL_<SLUG> configured)
  -- 'internal' — self-seeded from our own equipment/job history, no OEM API configured yet
  source text NOT NULL DEFAULT 'internal' CHECK (source IN ('oem_api', 'internal')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manufacturer_id, model_number)
);

CREATE INDEX IF NOT EXISTS idx_oem_models_manufacturer ON oem_equipment_models(manufacturer_id);
CREATE INDEX IF NOT EXISTS idx_oem_models_model_number ON oem_equipment_models(model_number);

CREATE TABLE IF NOT EXISTS oem_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer_id uuid NOT NULL REFERENCES oem_manufacturers(id) ON DELETE CASCADE,
  model_id uuid REFERENCES oem_equipment_models(id) ON DELETE CASCADE,
  part_number text NOT NULL,
  part_name text NOT NULL,
  category text,
  avg_price numeric(10,2),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oem_parts_model ON oem_parts(model_id);

CREATE TABLE IF NOT EXISTS oem_recalls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer_id uuid NOT NULL REFERENCES oem_manufacturers(id) ON DELETE CASCADE,
  model_id uuid REFERENCES oem_equipment_models(id) ON DELETE CASCADE,
  recall_number text NOT NULL,
  title text NOT NULL,
  description text,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  issued_date date,
  remedy text,
  source_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manufacturer_id, recall_number)
);

CREATE INDEX IF NOT EXISTS idx_oem_recalls_model ON oem_recalls(model_id);

CREATE TABLE IF NOT EXISTS oem_service_bulletins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer_id uuid NOT NULL REFERENCES oem_manufacturers(id) ON DELETE CASCADE,
  model_id uuid REFERENCES oem_equipment_models(id) ON DELETE CASCADE,
  bulletin_number text NOT NULL,
  title text NOT NULL,
  description text,
  issued_date date,
  source_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manufacturer_id, bulletin_number)
);

CREATE INDEX IF NOT EXISTS idx_oem_bulletins_model ON oem_service_bulletins(model_id);

CREATE TABLE IF NOT EXISTS oem_failure_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES oem_equipment_models(id) ON DELETE CASCADE,
  failure_mode text NOT NULL,
  typical_age_months integer,
  sample_size integer NOT NULL DEFAULT 0,
  frequency_score numeric(5,2) NOT NULL DEFAULT 0,
  common_fix text,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, failure_mode)
);

CREATE INDEX IF NOT EXISTS idx_oem_failure_patterns_model ON oem_failure_patterns(model_id);

ALTER TABLE oem_manufacturers ENABLE ROW LEVEL SECURITY;
ALTER TABLE oem_equipment_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE oem_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE oem_recalls ENABLE ROW LEVEL SECURITY;
ALTER TABLE oem_service_bulletins ENABLE ROW LEVEL SECURITY;
ALTER TABLE oem_failure_patterns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read_oem_manufacturers" ON oem_manufacturers FOR SELECT TO authenticated USING (true);
CREATE POLICY "read_oem_equipment_models" ON oem_equipment_models FOR SELECT TO authenticated USING (true);
CREATE POLICY "read_oem_parts" ON oem_parts FOR SELECT TO authenticated USING (true);
CREATE POLICY "read_oem_recalls" ON oem_recalls FOR SELECT TO authenticated USING (true);
CREATE POLICY "read_oem_service_bulletins" ON oem_service_bulletins FOR SELECT TO authenticated USING (true);
CREATE POLICY "read_oem_failure_patterns" ON oem_failure_patterns FOR SELECT TO authenticated USING (true);

-- No INSERT/UPDATE/DELETE policy for `authenticated` on the reference layer
-- on purpose: only the service-role key (used by oem-graph-enrich) may
-- write here — same trust boundary this project already relies on for
-- every other scheduled/cross-account function.

-- ---------- Per-account layer ----------

CREATE TABLE IF NOT EXISTS equipment_oem_link (
  equipment_id uuid PRIMARY KEY REFERENCES equipment(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  manufacturer_id uuid REFERENCES oem_manufacturers(id) ON DELETE SET NULL,
  model_id uuid REFERENCES oem_equipment_models(id) ON DELETE SET NULL,
  match_confidence numeric(4,3),
  enrichment_status text NOT NULL DEFAULT 'pending' CHECK (enrichment_status IN ('pending', 'matched', 'unmatched', 'error')),
  last_enriched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_equipment_oem_link_user ON equipment_oem_link(user_id);
CREATE INDEX IF NOT EXISTS idx_equipment_oem_link_model ON equipment_oem_link(model_id);

ALTER TABLE equipment_oem_link ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_equipment_oem_link" ON equipment_oem_link FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
CREATE POLICY "insert_own_equipment_oem_link" ON equipment_oem_link FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "update_own_equipment_oem_link" ON equipment_oem_link FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS equipment_oem_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  alert_type text NOT NULL CHECK (alert_type IN ('recall', 'bulletin', 'failure_pattern')),
  reference_id uuid,
  title text NOT NULL,
  message text NOT NULL,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  is_dismissed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_equipment_oem_alerts_equipment ON equipment_oem_alerts(equipment_id);
CREATE INDEX IF NOT EXISTS idx_equipment_oem_alerts_user ON equipment_oem_alerts(user_id) WHERE is_dismissed = false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_equipment_oem_alerts_dedupe
  ON equipment_oem_alerts(equipment_id, alert_type, reference_id) WHERE reference_id IS NOT NULL;

ALTER TABLE equipment_oem_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_equipment_oem_alerts" ON equipment_oem_alerts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
CREATE POLICY "update_own_equipment_oem_alerts" ON equipment_oem_alerts FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

-- Seed the manufacturer roster so the adapter layer + UI have something to
-- reference from day one, even before any model catalog is enriched.
INSERT INTO oem_manufacturers (slug, name, api_adapter) VALUES
  ('carrier', 'Carrier', 'generic'),
  ('trane', 'Trane', 'generic'),
  ('lennox', 'Lennox', 'generic'),
  ('rheem', 'Rheem', 'generic'),
  ('goodman', 'Goodman', 'generic'),
  ('bosch', 'Bosch', 'generic'),
  ('daikin', 'Daikin', 'generic')
ON CONFLICT (slug) DO NOTHING;
