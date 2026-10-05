/*
  # AI Field Scientist — hypothesis-driven research for the business itself

  ## Why
  Business Scientist (20261203000000) starts from a *decision* the owner has
  not acted on. The Field Scientist starts from the *data*: it mines completed
  jobs for segments whose callback rate differs from the rest of the business
  (e.g. "Group A on equipment family X"), checks the finding against
  confounding (stratified Cochran–Mantel–Haenszel) and multiple testing
  (Benjamini–Hochberg FDR), asks the AI ONLY for candidate causes + a
  job-level intervention, then runs a pre-registered, hash-randomised
  experiment on real upcoming jobs and accepts / rejects the hypothesis with a
  plain two-proportion test. Accepted / rejected results are written into
  Organizational Memory (org_memory_entries) as a playbook / failure pattern.

  ## Integrity rules (enforced in src/lib/fieldScientist.ts)
  - All statistics are deterministic arithmetic; the model never sees or
    influences a p-value, sample size, arm assignment or verdict.
  - Arms are assigned by hash(seed, job_id) and written to jobs.tags as
    `fs:<hypothesis-short-id>:t|c` BEFORE outcomes exist.
  - Only "mature" jobs (completed > callback window ago) count as outcomes.

  ## Tables
  - team_members.tech_group   — optional label, enables "Technician Group A" segments
  - field_hypotheses          — one row per hypothesis (discovery -> causes -> experiment -> verdict)
  - field_hypothesis_events   — append-only audit trail of every transition
*/

ALTER TABLE team_members ADD COLUMN IF NOT EXISTS tech_group text;

CREATE TABLE IF NOT EXISTS field_hypotheses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  dedupe_key text NOT NULL,

  outcome_metric text NOT NULL DEFAULT 'callback_rate' CHECK (outcome_metric IN ('callback_rate')),
  segment_dimension text NOT NULL
    CHECK (segment_dimension IN ('technician', 'tech_group', 'equipment_type', 'service_type', 'tech_x_equipment', 'time_bucket', 'duration_bucket')),
  segment_label text NOT NULL,
  segment_definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  direction text NOT NULL CHECK (direction IN ('worse', 'better')),
  statement text NOT NULL,

  /* Deterministic discovery stats + exploratory drill-down (see fieldScientist.ts) */
  discovery jsonb NOT NULL DEFAULT '{}'::jsonb,

  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'ready', 'testing', 'accepted', 'rejected', 'inconclusive', 'dismissed')),

  /* AI-proposed candidate causes: [{id,label,mechanism,intervention,priority}] */
  candidate_causes jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_cause_id text,

  /* Pre-registered design: sample size, seed, tag prefix, alpha, power ... */
  experiment_design jsonb,
  experiment_started_at timestamptz,
  experiment_ends_at timestamptz,
  experiment_result jsonb,

  verdict_reasoning text,
  playbook_entry_id uuid REFERENCES org_memory_entries(id) ON DELETE SET NULL,
  decided_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT field_hypotheses_unique_dedupe UNIQUE (user_id, dedupe_key),
  CONSTRAINT field_hypotheses_discovery_is_object CHECK (jsonb_typeof(discovery) = 'object'),
  CONSTRAINT field_hypotheses_segment_is_object CHECK (jsonb_typeof(segment_definition) = 'object'),
  CONSTRAINT field_hypotheses_causes_is_array CHECK (jsonb_typeof(candidate_causes) = 'array'),
  CONSTRAINT field_hypotheses_design_is_object CHECK (experiment_design IS NULL OR jsonb_typeof(experiment_design) = 'object'),
  CONSTRAINT field_hypotheses_result_is_object CHECK (experiment_result IS NULL OR jsonb_typeof(experiment_result) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_field_hypotheses_user_status ON field_hypotheses(user_id, status, created_at DESC);

DROP TRIGGER IF EXISTS trg_field_hypotheses_updated_at ON field_hypotheses;
CREATE TRIGGER trg_field_hypotheses_updated_at
  BEFORE UPDATE ON field_hypotheses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS field_hypothesis_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  hypothesis_id uuid NOT NULL REFERENCES field_hypotheses(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_field_hypothesis_events_hyp ON field_hypothesis_events(hypothesis_id, created_at);

-- =============================================================
-- RLS — account-scoped, same idiom as every other table here
-- =============================================================
ALTER TABLE field_hypotheses ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_hypothesis_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_field_hypotheses" ON field_hypotheses;
CREATE POLICY "select_own_field_hypotheses" ON field_hypotheses FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_field_hypotheses" ON field_hypotheses;
CREATE POLICY "insert_own_field_hypotheses" ON field_hypotheses FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_field_hypotheses" ON field_hypotheses;
CREATE POLICY "update_own_field_hypotheses" ON field_hypotheses FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_field_hypotheses" ON field_hypotheses;
CREATE POLICY "delete_own_field_hypotheses" ON field_hypotheses FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- Events are append-only for clients: select + insert, no update/delete.
DROP POLICY IF EXISTS "select_own_field_hypothesis_events" ON field_hypothesis_events;
CREATE POLICY "select_own_field_hypothesis_events" ON field_hypothesis_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_field_hypothesis_events" ON field_hypothesis_events;
CREATE POLICY "insert_own_field_hypothesis_events" ON field_hypothesis_events FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
