/*
  # Compounding Intelligence Flywheel

  ## Why
  This project already has the raw ingredients of a learning loop —
  org_memory_entries (confidence-scored lessons), business_immune_signals
  (confirmed true_positive threats), next_best_actions (the daily action
  feed), business_counterfactuals and regret_console_decisions — but
  nothing connects them. A 90%-confidence lesson just sits in a table
  forever; it never becomes a real task anyone acts on. This migration
  adds the missing connective tissue, not a new parallel knowledge base:

    HARVEST  -> read existing outcome data (org_memory_entries,
                business_immune_signals) — no new capture tables.
    PROMOTE  -> once a lesson clears a confidence/sample-size bar, or a
                threat detector has repeated confirmed true positives,
                turn it into a real row in next_best_actions (the same
                feed the owner already checks every morning), logged in
                flywheel_promotions so it's never promoted twice.
    MEASURE  -> a weekly rollup (flywheel_snapshots) of how much smarter
                and more automated the account got — the actual
                "compounding" curve.

  ## IMPORTANT — read before applying
  Section 1 widens the next_best_actions.category CHECK constraint to
  add 'compounding_insight'. The IN (...) list below reflects the
  categories in this project's next-best-action-engine migration as of
  the zip you gave me (`estimate_risk`, `invoice_risk`, `churn_risk`,
  `capacity_gap`). If you've added more categories since, open your
  current constraint (`\d next_best_actions` in SQL, or Table Editor)
  and merge any missing values into the list below before running.

  ## Deploy order
    1. Run this migration.
    2. supabase functions deploy flywheel-engine --no-verify-jwt
    3. Point your existing external cron at flywheel-engine, once a day
       (or once a week — this is a slow-compounding signal, it doesn't
       need to run every 10 minutes like the recovery agents).
    4. Apply the four code edits delivered alongside this migration.
*/

-- =============================================================
-- 1. Widen next_best_actions so a promoted lesson can land there
-- =============================================================

ALTER TABLE next_best_actions
  DROP CONSTRAINT IF EXISTS next_best_actions_category_check;

ALTER TABLE next_best_actions
  ADD CONSTRAINT next_best_actions_category_check
  CHECK (category IN ('estimate_risk', 'invoice_risk', 'churn_risk', 'capacity_gap', 'compounding_insight'));

-- =============================================================
-- 2. Idempotency markers on the two source tables — a lesson or a
--    confirmed threat pattern is promoted at most once.
-- =============================================================

ALTER TABLE org_memory_entries
  ADD COLUMN IF NOT EXISTS promoted_at timestamptz;

ALTER TABLE business_immune_signals
  ADD COLUMN IF NOT EXISTS flywheel_promoted_at timestamptz;

-- =============================================================
-- 3. Promotion log — the audit trail of "knowledge became action"
-- =============================================================

CREATE TABLE IF NOT EXISTS flywheel_promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  source_type text NOT NULL CHECK (source_type IN ('org_memory_entry', 'business_immune_detector')),
  source_id uuid,     -- set when source_type = 'org_memory_entry'
  source_key text,    -- set when source_type = 'business_immune_detector' (the detector name)

  promoted_action text NOT NULL DEFAULT 'next_best_action_created',
  next_best_action_id uuid REFERENCES next_best_actions(id) ON DELETE SET NULL,
  detail text,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_flywheel_promotions_source_id
  ON flywheel_promotions(user_id, source_type, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_flywheel_promotions_source_key
  ON flywheel_promotions(user_id, source_type, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flywheel_promotions_user_created ON flywheel_promotions(user_id, created_at DESC);

ALTER TABLE flywheel_promotions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_flywheel_promotions" ON flywheel_promotions;
CREATE POLICY "select_own_flywheel_promotions"
ON flywheel_promotions FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

-- No client INSERT policy: only the flywheel-engine Edge Function
-- (service role) writes promotions.

-- =============================================================
-- 4. Weekly compounding snapshot — the measurable "is it working" curve
-- =============================================================

CREATE TABLE IF NOT EXISTS flywheel_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL DEFAULT current_date,

  total_actions_logged integer NOT NULL DEFAULT 0,
  total_active_lessons integer NOT NULL DEFAULT 0,
  avg_lesson_confidence numeric NOT NULL DEFAULT 0,
  promotions_created integer NOT NULL DEFAULT 0,
  promotions_acted_on integer NOT NULL DEFAULT 0,
  compounding_score integer NOT NULL DEFAULT 50 CHECK (compounding_score BETWEEN 0 AND 100),

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_flywheel_snapshots_user_date ON flywheel_snapshots(user_id, snapshot_date DESC);

ALTER TABLE flywheel_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_flywheel_snapshots" ON flywheel_snapshots;
CREATE POLICY "select_own_flywheel_snapshots"
ON flywheel_snapshots FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

-- No client INSERT policy: only the flywheel-engine Edge Function writes snapshots.
