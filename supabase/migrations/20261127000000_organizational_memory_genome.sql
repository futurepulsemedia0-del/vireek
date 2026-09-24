/*
  # Organizational Memory Genome

  ## Why
  When a manager or senior technician leaves, everything they learned about
  "what actually works here" leaves with them: which warranty distributor
  approves claims without a fight, which contract terms customers actually
  renew, which technician is the only one who can handle a certain repair.
  Nothing in this project captures that as a durable, queryable asset.

  ## What this does
  - `org_memory_entries`: one row per distilled "lesson" — either
    auto-mined (deterministic, from real outcome columns already in this
    project, same "AI only reasons over real numbers" philosophy as
    business-decision-engine / estimate-recovery-agent) or manually logged
    by a manager/technician and attributed to them via `contributor_id`
    (team_members.id) — so it survives after that person leaves.
  - `confidence_score` for auto-mined rows is computed, not guessed:
    win_rate * min(1, sample_size / 10) * 100 — a 90% win rate on 2 samples
    scores low; the same rate on 10+ samples scores near 90. Manual entries
    are self-rated by the person logging them and can be raised by teammates
    "endorsing" the entry (increment_memory_endorsement RPC).
  - Mining (`mine-organizational-memory` edge function) reads two already-
    verified, already-categorical outcome sources:
      - `warranty_claims.distributor` vs resolved status (approved /
        denied / credit_received) — which distributors are worth filing
        with.
      - `commercial_contracts.contract_type` vs resolved status (renewed /
        terminated) — which contract types actually renew.
    Deliberately NOT more sources than this in v1 — better to ship two
    correct, verified miners than five speculative ones.
  - `dedupe_key` is NOT NULL with a real (non-partial) UNIQUE(user_id,
    dedupe_key) constraint so `.upsert(rows, { onConflict: 'user_id,dedupe_key' })`
    works correctly from the edge function. Manual entries never set it, so
    the column default (a fresh random key) always keeps them unique —
    this avoids the classic partial-unique-index-vs-upsert mismatch (a
    partial index needs its WHERE predicate repeated in ON CONFLICT, which
    supabase-js's `onConflict` option cannot express).

  ## RLS
  Same per-tenant ownership pattern as every other table here, scoped to
  `public.get_account_owner_id()`.
*/

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS org_memory_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  entry_type text NOT NULL CHECK (entry_type IN ('winning_playbook', 'failure_pattern', 'tribal_knowledge', 'best_practice')),
  title text NOT NULL,
  situation text,
  action_taken text,
  outcome_summary text,

  confidence_score integer NOT NULL DEFAULT 50 CHECK (confidence_score BETWEEN 0 AND 100),
  sample_size integer,

  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'warranty_claims', 'commercial_contracts')),
  -- Auto-mined rows set this explicitly (e.g. 'warranty_claims:ServiceTitan Supply')
  -- so a re-run UPSERTs the same row instead of duplicating it. Manual rows
  -- never set it, so the default below keeps them unique automatically.
  dedupe_key text NOT NULL DEFAULT ('manual:' || gen_random_uuid()::text),

  contributor_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  tags text[] NOT NULL DEFAULT '{}',

  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_review', 'retired')),
  endorsement_count integer NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT org_memory_entries_unique_dedupe UNIQUE (user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_org_memory_entries_user_status ON org_memory_entries(user_id, status);
CREATE INDEX IF NOT EXISTS idx_org_memory_entries_type ON org_memory_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_org_memory_entries_contributor ON org_memory_entries(contributor_id) WHERE contributor_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_org_memory_entries_updated_at ON org_memory_entries;
CREATE TRIGGER trg_org_memory_entries_updated_at
  BEFORE UPDATE ON org_memory_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE org_memory_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_org_memory_entries" ON org_memory_entries;
CREATE POLICY "select_own_org_memory_entries" ON org_memory_entries FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_org_memory_entries" ON org_memory_entries;
CREATE POLICY "insert_own_org_memory_entries" ON org_memory_entries FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_org_memory_entries" ON org_memory_entries;
CREATE POLICY "update_own_org_memory_entries" ON org_memory_entries FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_org_memory_entries" ON org_memory_entries;
CREATE POLICY "delete_own_org_memory_entries" ON org_memory_entries FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- Atomic endorsement counter — avoids a read-modify-write race if two
-- teammates endorse the same entry at nearly the same time.
-- =============================================================
CREATE OR REPLACE FUNCTION public.increment_memory_endorsement(p_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE org_memory_entries
  SET endorsement_count = endorsement_count + 1
  WHERE id = p_id AND user_id = public.get_account_owner_id()
  RETURNING endorsement_count INTO v_count;

  IF v_count IS NULL THEN
    RAISE EXCEPTION 'Memory entry not found or not accessible';
  END IF;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_memory_endorsement(uuid) TO authenticated;
