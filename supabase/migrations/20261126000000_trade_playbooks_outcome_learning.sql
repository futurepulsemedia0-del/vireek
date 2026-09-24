/*
  # Trade-Specific Playbooks + Outcome Learning

  Playbook CONTENT (checklists, troubleshooting trees, price seeds, benchmarks)
  lives in code (src/lib/tradePlaybookCatalog.ts). This migration stores only
  tenant state and the learning loop:

  - trade_playbook_installs: which trade playbook a tenant installed, and what
    the install created (idempotent: one row per tenant + playbook).
  - job_outcomes: one row per completed job (UNIQUE job_id) — resolution, root
    cause, checklist steps done, and a snapshot of revenue/cost/duration so later
    job edits never rewrite history. `caused_callback` is maintained by triggers
    below from jobs.is_rework / rework_of_job_id, so it is correct no matter which
    client creates the rework job.
  - trade_playbook_tuning: tenant-learned overrides (target duration, steps that
    became critical). Written only when the owner accepts a suggestion.
  - playbook_learning_suggestions: deterministic, explainable suggestions with
    evidence. Nothing is applied automatically; owner accepts or dismisses.

  RLS: account-scoped via get_account_owner_id(), same as jobs.
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS trade_playbook_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  playbook_slug text NOT NULL,
  catalog_version integer NOT NULL DEFAULT 1,
  price_items_added integer NOT NULL DEFAULT 0 CHECK (price_items_added >= 0),
  articles_added integer NOT NULL DEFAULT 0 CHECK (articles_added >= 0),
  installed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, playbook_slug)
);

CREATE TABLE IF NOT EXISTS job_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  playbook_slug text NOT NULL,
  job_type_key text NOT NULL,
  root_cause_key text,
  resolution text NOT NULL
    CHECK (resolution IN ('fixed_first_visit', 'fixed_followup', 'parts_pending', 'quote_declined', 'unresolved')),
  checklist_done text[] NOT NULL DEFAULT '{}',
  checklist_total integer NOT NULL DEFAULT 0 CHECK (checklist_total >= 0),
  parts_used text[] NOT NULL DEFAULT '{}',
  notes text,
  revenue_cents integer CHECK (revenue_cents IS NULL OR revenue_cents >= 0),
  cost_cents integer CHECK (cost_cents IS NULL OR cost_cents >= 0),
  duration_minutes integer CHECK (duration_minutes IS NULL OR duration_minutes >= 0),
  is_rework boolean NOT NULL DEFAULT false,
  caused_callback boolean NOT NULL DEFAULT false,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  customer_rating smallint CHECK (customer_rating IS NULL OR customer_rating BETWEEN 1 AND 5),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id)
);

CREATE INDEX IF NOT EXISTS idx_job_outcomes_user_type
  ON job_outcomes(user_id, playbook_slug, job_type_key, recorded_at DESC);

CREATE TABLE IF NOT EXISTS trade_playbook_tuning (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  playbook_slug text NOT NULL,
  job_type_key text NOT NULL,
  target_duration_minutes integer CHECK (target_duration_minutes IS NULL OR target_duration_minutes > 0),
  critical_item_ids text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, playbook_slug, job_type_key)
);

CREATE TABLE IF NOT EXISTS playbook_learning_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  playbook_slug text NOT NULL,
  job_type_key text NOT NULL,
  suggestion_key text NOT NULL,
  kind text NOT NULL
    CHECK (kind IN ('price_adjust', 'duration_adjust', 'root_cause_article', 'checklist_critical')),
  title text NOT NULL,
  rationale text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE (user_id, suggestion_key)
);

CREATE INDEX IF NOT EXISTS idx_playbook_learning_suggestions_status
  ON playbook_learning_suggestions(user_id, status, created_at DESC);

-- =============================================================
-- RLS — account-scoped, same idiom as jobs
-- =============================================================

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trade_playbook_installs', 'job_outcomes', 'trade_playbook_tuning', 'playbook_learning_suggestions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'select_own_' || t, t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id())', 'select_own_' || t, t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'insert_own_' || t, t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id())', 'insert_own_' || t, t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'update_own_' || t, t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id())', 'update_own_' || t, t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'delete_own_' || t, t);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id())', 'delete_own_' || t, t);
  END LOOP;
END $$;

-- =============================================================
-- TRIGGERS
-- =============================================================

CREATE OR REPLACE FUNCTION set_trade_playbook_tuning_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_trade_playbook_tuning_updated_at ON trade_playbook_tuning;
CREATE TRIGGER trg_trade_playbook_tuning_updated_at
  BEFORE UPDATE ON trade_playbook_tuning
  FOR EACH ROW EXECUTE FUNCTION set_trade_playbook_tuning_updated_at();

-- A callback that already exists when an outcome is recorded.
CREATE OR REPLACE FUNCTION job_outcomes_set_callback_flag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.caused_callback := EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.rework_of_job_id = NEW.job_id AND j.user_id = NEW.user_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_outcomes_callback_flag ON job_outcomes;
CREATE TRIGGER trg_job_outcomes_callback_flag
  BEFORE INSERT ON job_outcomes
  FOR EACH ROW EXECUTE FUNCTION job_outcomes_set_callback_flag();

-- A rework job created (or flagged) after the original outcome was recorded.
CREATE OR REPLACE FUNCTION flag_outcome_callback_from_rework()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_rework IS TRUE AND NEW.rework_of_job_id IS NOT NULL THEN
    UPDATE job_outcomes
       SET caused_callback = true
     WHERE job_id = NEW.rework_of_job_id
       AND user_id = NEW.user_id
       AND caused_callback = false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_flag_outcome_callback_from_rework ON jobs;
CREATE TRIGGER trg_flag_outcome_callback_from_rework
  AFTER INSERT OR UPDATE OF is_rework, rework_of_job_id ON jobs
  FOR EACH ROW EXECUTE FUNCTION flag_outcome_callback_from_rework();
