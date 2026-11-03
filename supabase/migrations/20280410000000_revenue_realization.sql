/*
  # Revenue Realization — leak radar on top of the existing recovery ledger

  ## Why
  revenue_recovery_events (missed calls, quotes, unbilled jobs, overdue invoices, memberships) is a
  per-source event ledger: one row per (source_table, source_id). Revenue Realization needs a
  unified, ranked list of leaks from ALL detectors, several per source record (a job can have an
  unbilled-parts leak AND an underpriced leak), with confidence, evidence, owner and a governed fix.
  Existing ledger rows are ADAPTED into revenue_leaks (ledger_event_id) — never re-detected.

  ## Safety (enforced in the database, not only in code)
  - Clients can only READ. All writes go through the revenue-realization-* edge functions (service role).
  - A leak can be 'realized' only with a positive realized_amount_cents AND a realized_proof.
  - An action can be 'executed' / 'undone' only if a human approved it (approved_by NOT NULL).
  - Executors create DRAFTS only; nothing here ever bills or messages a customer.

  ## Deploy order
    1. Run this migration.
    2. supabase functions deploy revenue-realization-run revenue-realization-action
    3. Point the existing cron at revenue-realization-run (same X-Cron-Secret as estimate-recovery-agent), daily.
  ## Rollback
    DROP TABLE revenue_realization_snapshots, revenue_leak_feedback, revenue_leak_actions, revenue_leaks CASCADE;
*/

CREATE TABLE IF NOT EXISTS revenue_leaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  detector text NOT NULL CHECK (detector IN (
    'missed_call', 'stale_quote', 'declined_risk_rec', 'unquoted_finding', 'uninvoiced_work',
    'unbilled_trip_fee', 'discount_over_policy', 'warranty_unfiled', 'agreement_expiring',
    'overdue_invoice', 'no_show_gap', 'membership_lapse', 'underpriced_job'
  )),
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 3 AND 200),
  pool_key text NOT NULL CHECK (char_length(pool_key) BETWEEN 3 AND 200),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  low_sample boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'realized', 'dismissed', 'false_positive', 'expired')),
  owner_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  source_label text CHECK (source_label IS NULL OR char_length(source_label) <= 120),
  customer_name text CHECK (customer_name IS NULL OR char_length(customer_name) <= 200),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) BETWEEN 1 AND 10),
  why_key text NOT NULL CHECK (char_length(why_key) <= 80),
  why_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  fix_kind text CHECK (fix_kind IS NULL OR fix_kind IN ('draft_followup', 'create_quote', 'invoice_correction', 'file_warranty_claim')),
  ledger_event_id uuid REFERENCES revenue_recovery_events(id) ON DELETE SET NULL,
  formula_version text NOT NULL,
  occurred_at timestamptz NOT NULL,
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  realized_at timestamptz,
  realized_amount_cents bigint CHECK (realized_amount_cents IS NULL OR realized_amount_cents > 0),
  realized_proof jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key),
  CONSTRAINT revenue_leaks_realized_needs_proof CHECK (
    status <> 'realized' OR (realized_amount_cents IS NOT NULL AND realized_proof IS NOT NULL AND realized_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_revenue_leaks_rank
  ON revenue_leaks (user_id, status, ((amount_cents * confidence)) DESC);
CREATE INDEX IF NOT EXISTS idx_revenue_leaks_detector ON revenue_leaks (user_id, detector, status);
CREATE INDEX IF NOT EXISTS idx_revenue_leaks_ledger ON revenue_leaks (ledger_event_id) WHERE ledger_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS revenue_leak_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  leak_id uuid NOT NULL REFERENCES revenue_leaks(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('draft_followup', 'create_quote', 'invoice_correction', 'file_warranty_claim')),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'executed', 'undone', 'rejected', 'failed')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  error text CHECK (error IS NULL OR char_length(error) <= 500),
  proposed_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  executed_at timestamptz,
  undone_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT revenue_leak_actions_human_approval CHECK (
    status NOT IN ('executed', 'undone') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);
-- One live action per leak: no double-execution, no parallel conflicting fixes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_revenue_leak_actions_live
  ON revenue_leak_actions (leak_id) WHERE status IN ('proposed', 'approved', 'executed');
CREATE INDEX IF NOT EXISTS idx_revenue_leak_actions_user ON revenue_leak_actions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS revenue_leak_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  leak_id uuid REFERENCES revenue_leaks(id) ON DELETE SET NULL,
  detector text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('true_positive', 'false_positive')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_revenue_leak_feedback_user ON revenue_leak_feedback (user_id, detector, verdict);

CREATE TABLE IF NOT EXISTS revenue_realization_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  period_month date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  captured_cents bigint NOT NULL CHECK (captured_cents >= 0),
  leaked_weighted_cents bigint NOT NULL CHECK (leaked_weighted_cents >= 0),
  leaked_full_cents bigint NOT NULL CHECK (leaked_full_cents >= 0),
  leaked_high_confidence_cents bigint NOT NULL CHECK (leaked_high_confidence_cents >= 0),
  realization_pct numeric(5,1) CHECK (realization_pct IS NULL OR realization_pct BETWEEN 0 AND 100),
  realization_pct_low numeric(5,1),
  realization_pct_high numeric(5,1),
  realized_cents bigint NOT NULL DEFAULT 0 CHECK (realized_cents >= 0),
  by_detector jsonb NOT NULL DEFAULT '{}'::jsonb,
  formula_version text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, period_month)
);

-- ---------------------------------------------------------------- RLS: read-only for clients
ALTER TABLE revenue_leaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_leak_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_leak_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_realization_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_revenue_leaks" ON revenue_leaks;
CREATE POLICY "select_own_revenue_leaks" ON revenue_leaks
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_revenue_leak_actions" ON revenue_leak_actions;
CREATE POLICY "select_own_revenue_leak_actions" ON revenue_leak_actions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_revenue_leak_feedback" ON revenue_leak_feedback;
CREATE POLICY "select_own_revenue_leak_feedback" ON revenue_leak_feedback
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_own_revenue_realization_snapshots" ON revenue_realization_snapshots;
CREATE POLICY "select_own_revenue_realization_snapshots" ON revenue_realization_snapshots
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- Deliberately NO insert/update/delete policies: writes are service-role only.

DROP TRIGGER IF EXISTS trg_revenue_leaks_updated_at ON revenue_leaks;
CREATE TRIGGER trg_revenue_leaks_updated_at BEFORE UPDATE ON revenue_leaks
  FOR EACH ROW EXECUTE FUNCTION public.set_revenue_recovery_updated_at();
DROP TRIGGER IF EXISTS trg_revenue_leak_actions_updated_at ON revenue_leak_actions;
CREATE TRIGGER trg_revenue_leak_actions_updated_at BEFORE UPDATE ON revenue_leak_actions
  FOR EACH ROW EXECUTE FUNCTION public.set_revenue_recovery_updated_at();
