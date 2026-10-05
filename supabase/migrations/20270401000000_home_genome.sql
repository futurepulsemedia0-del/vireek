/*
  # Home Genome — recorded history events per property

  ## Why
  The Home Genome is the permanent, ordered history of one home: construction,
  systems, equipment, repairs, failures, maintenance, replacements, energy, cost
  and future risk. Almost all of it is derived from tables Vireek already has
  (customer_sites, equipment, jobs, job_equipment, equipment_maintenance_alerts,
  home_energy_readings). The one thing Vireek cannot derive is what happened
  BEFORE the home was on Vireek ("HVAC installed 2018, capacitor failure 2022").

  ## What this does
  Adds ONE new table, `home_genome_events`: one row per hand-recorded history
  event. Purely additive: no existing table, column, policy or function is
  touched. The genome is computed client-side (src/lib/homeGenome.ts) and uses
  these rows only when present, so the feature keeps working if this migration
  has not been applied yet.

  ## Security
  Same ownership model as customer_sites / home_energy_readings: rows belong to
  the account owner (public.get_account_owner_id()), so team members read and
  write the owner's data. The property — and the equipment, when given — must
  belong to the same owner (enforced by trigger, not just by foreign keys), so a
  row can never point at another account's records.
*/

CREATE TABLE IF NOT EXISTS home_genome_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  site_id uuid NOT NULL REFERENCES customer_sites(id) ON DELETE CASCADE,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  system_key text NOT NULL,
  event_kind text NOT NULL,
  occurred_on date NOT NULL,
  title text NOT NULL,
  note text,
  cost_usd numeric(10, 2),
  source text NOT NULL DEFAULT 'manual',
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT home_genome_events_system_valid CHECK (system_key IN ('home', 'hvac', 'plumbing', 'electrical', 'water_heater', 'roof', 'safety')),
  CONSTRAINT home_genome_events_kind_valid CHECK (event_kind IN ('install', 'maintenance', 'inspection', 'repair', 'failure', 'replacement', 'upgrade')),
  CONSTRAINT home_genome_events_source_valid CHECK (source IN ('manual', 'import', 'contractor')),
  CONSTRAINT home_genome_events_date_range CHECK (occurred_on >= DATE '1900-01-01' AND occurred_on <= CURRENT_DATE + 1),
  CONSTRAINT home_genome_events_title_len CHECK (char_length(btrim(title)) BETWEEN 3 AND 120),
  CONSTRAINT home_genome_events_note_len CHECK (note IS NULL OR char_length(note) <= 1000),
  CONSTRAINT home_genome_events_cost_range CHECK (cost_usd IS NULL OR (cost_usd >= 0 AND cost_usd <= 10000000))
);

CREATE INDEX IF NOT EXISTS idx_home_genome_events_site_date
  ON home_genome_events (site_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS idx_home_genome_events_user_id
  ON home_genome_events (user_id);
CREATE INDEX IF NOT EXISTS idx_home_genome_events_equipment_id
  ON home_genome_events (equipment_id) WHERE equipment_id IS NOT NULL;

-- A genome event may only reference a property (and unit) owned by the same account.
CREATE OR REPLACE FUNCTION public.home_genome_events_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM customer_sites s WHERE s.id = NEW.site_id AND s.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Property does not belong to this account.' USING ERRCODE = '42501';
  END IF;
  IF NEW.equipment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM equipment e WHERE e.id = NEW.equipment_id AND e.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Equipment does not belong to this account.' USING ERRCODE = '42501';
  END IF;
  NEW.title := btrim(NEW.title);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_home_genome_events_guard ON home_genome_events;
CREATE TRIGGER trg_home_genome_events_guard
  BEFORE INSERT OR UPDATE ON home_genome_events
  FOR EACH ROW EXECUTE FUNCTION public.home_genome_events_guard();

ALTER TABLE home_genome_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_home_genome_events" ON home_genome_events;
CREATE POLICY "select_own_home_genome_events" ON home_genome_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_home_genome_events" ON home_genome_events;
CREATE POLICY "insert_own_home_genome_events" ON home_genome_events FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_home_genome_events" ON home_genome_events;
CREATE POLICY "update_own_home_genome_events" ON home_genome_events FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_home_genome_events" ON home_genome_events;
CREATE POLICY "delete_own_home_genome_events" ON home_genome_events FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

COMMENT ON TABLE home_genome_events IS
  'Hand-recorded history events per property (work done before the home was on Vireek). Feeds the Home Genome.';
