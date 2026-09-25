/*
  # Business Fragility Score

  fragility_settings: owner-declared inputs the software cannot observe
  (spare technician capacity and share of manual work). One row per account.

  fragility_snapshots: append-only history of computed scores, so the owner can
  see whether fragility is rising or falling. The score itself is computed in
  code (src/lib/fragilityScore.ts) from existing tables.

  RLS: account-scoped via get_account_owner_id().
*/

CREATE TABLE IF NOT EXISTS fragility_settings (
  user_id uuid PRIMARY KEY DEFAULT auth.uid(),
  backup_capacity_pct numeric(5,2)
    CHECK (backup_capacity_pct IS NULL OR backup_capacity_pct BETWEEN 0 AND 100),
  manual_work_pct numeric(5,2)
    CHECK (manual_work_pct IS NULL OR manual_work_pct BETWEEN 0 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fragility_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  score numeric(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  band text NOT NULL CHECK (band IN ('resilient', 'exposed', 'fragile', 'critical')),
  scalability numeric(5,2) CHECK (scalability IS NULL OR scalability BETWEEN 0 AND 100),
  coverage numeric(4,3) NOT NULL CHECK (coverage BETWEEN 0 AND 1),
  components jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fragility_snapshots_user_created
  ON fragility_snapshots(user_id, created_at DESC);

-- RLS
ALTER TABLE fragility_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_own_fragility_settings ON fragility_settings;
CREATE POLICY select_own_fragility_settings ON fragility_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS insert_own_fragility_settings ON fragility_settings;
CREATE POLICY insert_own_fragility_settings ON fragility_settings
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS update_own_fragility_settings ON fragility_settings;
CREATE POLICY update_own_fragility_settings ON fragility_settings
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

-- Snapshots are history: select + insert only.
ALTER TABLE fragility_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_own_fragility_snapshots ON fragility_snapshots;
CREATE POLICY select_own_fragility_snapshots ON fragility_snapshots
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS insert_own_fragility_snapshots ON fragility_snapshots;
CREATE POLICY insert_own_fragility_snapshots ON fragility_snapshots
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
