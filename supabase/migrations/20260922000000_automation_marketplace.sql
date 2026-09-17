/*
  # Automation Marketplace (installs)

  - The catalog of automations itself is curated content, shipped in
    src/lib/automationMarketplace.ts (same pattern as the App Marketplace's
    PARTNER_LISTINGS) — not stored in the database, so new automations can
    ship without a migration.
  - automation_installs tracks which of those catalog automations a given
    business has turned on, with a per-install `config` jsonb for any
    parameters (delay minutes, message template, etc). One row per
    (user, template_slug); RLS scoped to auth.uid(), same pattern as
    price_book_items.
*/

CREATE TABLE IF NOT EXISTS automation_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  template_slug text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, template_slug)
);

CREATE INDEX IF NOT EXISTS idx_automation_installs_user_id ON automation_installs(user_id);
CREATE INDEX IF NOT EXISTS idx_automation_installs_user_status ON automation_installs(user_id, status);

ALTER TABLE automation_installs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_automation_installs" ON automation_installs;
CREATE POLICY "select_own_automation_installs" ON automation_installs FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "insert_own_automation_installs" ON automation_installs;
CREATE POLICY "insert_own_automation_installs" ON automation_installs FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "update_own_automation_installs" ON automation_installs;
CREATE POLICY "update_own_automation_installs" ON automation_installs FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "delete_own_automation_installs" ON automation_installs;
CREATE POLICY "delete_own_automation_installs" ON automation_installs FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION set_automation_installs_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_automation_installs_updated_at ON automation_installs;
CREATE TRIGGER trg_automation_installs_updated_at
  BEFORE UPDATE ON automation_installs
  FOR EACH ROW EXECUTE FUNCTION set_automation_installs_updated_at();
