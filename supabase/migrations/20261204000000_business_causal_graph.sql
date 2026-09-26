/*
  # Causal Business Graph

  ## Why
  The World Model (src/lib/worldModel.ts) assembles the *structural*
  graph — customer, property, asset, job, technician, invoice,
  communication, event — live from existing tables, so it needs no new
  storage of its own. This migration adds the one thing that genuinely
  doesn't exist anywhere yet: CAUSAL edges between those nodes — "this
  emergency call caused this job", "this overdue maintenance caused
  this job", "this declined quote contributed to this customer going
  inactive" — some detected by rules client-side and confirmed by the
  owner, some asserted by the owner directly. Either way they need to
  persist and accumulate, which the structural graph doesn't.
*/

CREATE TABLE IF NOT EXISTS business_causal_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  cause_type text NOT NULL CHECK (cause_type IN
    ('customer', 'property', 'asset', 'job', 'technician', 'invoice', 'communication', 'event')),
  cause_id text NOT NULL,
  cause_label text NOT NULL,

  effect_type text NOT NULL CHECK (effect_type IN
    ('customer', 'property', 'asset', 'job', 'technician', 'invoice', 'communication', 'event')),
  effect_id text NOT NULL,
  effect_label text NOT NULL,

  relationship text NOT NULL DEFAULT 'contributes_to'
    CHECK (relationship IN ('contributes_to', 'prevents', 'correlates_with')),
  /* -1 (strong negative effect) .. 1 (strong positive/causal effect) */
  strength numeric NOT NULL DEFAULT 0.5 CHECK (strength BETWEEN -1 AND 1),
  confidence text NOT NULL DEFAULT 'low' CHECK (confidence IN ('low', 'medium', 'high')),

  /* 'rule' = surfaced by a client-side heuristic and confirmed by the
     owner; 'manual' = the owner drew this edge themselves */
  detected_by text NOT NULL DEFAULT 'manual' CHECK (detected_by IN ('rule', 'manual')),
  rule_key text,
  /* free-form supporting facts, e.g. { "gap_hours": 3, "sample_size": 5 } */
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,

  created_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_causal_edges_evidence_is_object') THEN
    ALTER TABLE business_causal_edges
      ADD CONSTRAINT business_causal_edges_evidence_is_object CHECK (jsonb_typeof(evidence) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_causal_edges_no_self_loop') THEN
    ALTER TABLE business_causal_edges
      ADD CONSTRAINT business_causal_edges_no_self_loop
      CHECK (NOT (cause_type = effect_type AND cause_id = effect_id));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_business_causal_edges_user
  ON business_causal_edges(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_causal_edges_cause
  ON business_causal_edges(user_id, cause_type, cause_id);
CREATE INDEX IF NOT EXISTS idx_business_causal_edges_effect
  ON business_causal_edges(user_id, effect_type, effect_id);
-- One confirmed edge per detected rule instance, so re-scanning never duplicates
CREATE UNIQUE INDEX IF NOT EXISTS uq_business_causal_edges_rule_instance
  ON business_causal_edges(user_id, rule_key, cause_id, effect_id) WHERE rule_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.touch_business_causal_edges_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_business_causal_edges_touch ON business_causal_edges;
CREATE TRIGGER trg_business_causal_edges_touch
  BEFORE UPDATE ON business_causal_edges
  FOR EACH ROW EXECUTE FUNCTION public.touch_business_causal_edges_updated_at();

ALTER TABLE business_causal_edges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_business_causal_edges" ON business_causal_edges;
CREATE POLICY "select_own_business_causal_edges" ON business_causal_edges
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_business_causal_edges" ON business_causal_edges;
CREATE POLICY "insert_own_business_causal_edges" ON business_causal_edges
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_business_causal_edges" ON business_causal_edges;
CREATE POLICY "update_own_business_causal_edges" ON business_causal_edges
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_business_causal_edges" ON business_causal_edges;
CREATE POLICY "delete_own_business_causal_edges" ON business_causal_edges
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());
