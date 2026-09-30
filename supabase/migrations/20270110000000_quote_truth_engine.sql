/*
  # Vireek Quote Truth Engine

  Deterministic "is this quote actually reasonable?" layer, kept separate from
  the Quote Builder. Purely additive: nothing existing is dropped or rewritten.

  - quote_truth_settings         per-account tuning (regional price index, fair-price tolerance)
  - quote_competitor_benchmarks  competitor / market prices the OWNER enters (the engine never
                                 invents market data)
  - quote_truth_analyses         append-only audit log of every analysis. Only the
                                 quote-truth-engine Edge Function (service role) writes it, so a
                                 verdict can't be forged through the REST API. The stored report
                                 contains cost/margin data, so reads are limited to the account
                                 owner and team members with can_view_billing.
  - quotes.truth_*               small cached summary for list views.
*/

-- =============================================================
-- Helper: may the caller see cost/margin-level analysis for this account?
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_view_quote_truth(p_owner uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth.uid() = p_owner
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      WHERE tm.account_owner_id = p_owner
        AND lower(tm.member_email) = lower((SELECT email FROM auth.users WHERE id = auth.uid()))
        AND COALESCE((tm.permissions ->> 'can_view_billing')::boolean, false)
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_view_quote_truth(uuid) TO authenticated;

-- =============================================================
-- 1. Settings
-- =============================================================

CREATE TABLE IF NOT EXISTS quote_truth_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  region_label text,
  regional_price_index numeric(4, 2) NOT NULL DEFAULT 1.00
    CHECK (regional_price_index >= 0.5 AND regional_price_index <= 2),
  max_premium_pct numeric(5, 2) NOT NULL DEFAULT 12
    CHECK (max_premium_pct >= 0 AND max_premium_pct <= 100),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN quote_truth_settings.regional_price_index IS 'Local price level vs. the reference market the network cohort represents (1.00 = same). Only scales network cohort figures; your own Price Book, quote history and competitor benchmarks are already local.';
COMMENT ON COLUMN quote_truth_settings.max_premium_pct IS 'How far above the top of the expected range a quote may sit before it is labelled overpriced.';

ALTER TABLE quote_truth_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_quote_truth_settings" ON quote_truth_settings;
CREATE POLICY "select_own_quote_truth_settings" ON quote_truth_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_quote_truth_settings" ON quote_truth_settings;
CREATE POLICY "insert_own_quote_truth_settings" ON quote_truth_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "update_own_quote_truth_settings" ON quote_truth_settings;
CREATE POLICY "update_own_quote_truth_settings" ON quote_truth_settings FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- =============================================================
-- 2. Competitor benchmarks (owner-entered)
-- =============================================================

CREATE TABLE IF NOT EXISTS quote_competitor_benchmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  service_keyword text NOT NULL CHECK (char_length(btrim(service_keyword)) BETWEEN 2 AND 120),
  region_label text,
  low_cents integer NOT NULL CHECK (low_cents > 0),
  high_cents integer NOT NULL,
  source_label text,
  notes text,
  observed_at date NOT NULL DEFAULT current_date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_competitor_benchmarks_range CHECK (high_cents >= low_cents)
);

CREATE INDEX IF NOT EXISTS idx_quote_competitor_benchmarks_user ON quote_competitor_benchmarks(user_id, observed_at DESC);

COMMENT ON TABLE quote_competitor_benchmarks IS 'Whole-job competitor / market price ranges entered by the account owner. service_keyword tokens must all appear in a quote for the benchmark to apply.';

ALTER TABLE quote_competitor_benchmarks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_quote_competitor_benchmarks" ON quote_competitor_benchmarks;
CREATE POLICY "select_own_quote_competitor_benchmarks" ON quote_competitor_benchmarks FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_quote_competitor_benchmarks" ON quote_competitor_benchmarks;
CREATE POLICY "insert_own_quote_competitor_benchmarks" ON quote_competitor_benchmarks FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "update_own_quote_competitor_benchmarks" ON quote_competitor_benchmarks;
CREATE POLICY "update_own_quote_competitor_benchmarks" ON quote_competitor_benchmarks FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "delete_own_quote_competitor_benchmarks" ON quote_competitor_benchmarks;
CREATE POLICY "delete_own_quote_competitor_benchmarks" ON quote_competitor_benchmarks FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- =============================================================
-- 3. Analyses (append-only audit log)
-- =============================================================

CREATE TABLE IF NOT EXISTS quote_truth_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  requested_by uuid,
  engine_version text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('well_priced', 'fair', 'high', 'overpriced', 'underpriced', 'low_evidence')),
  subtotal_cents integer NOT NULL,
  expected_low_cents integer NOT NULL,
  expected_high_cents integer NOT NULL,
  rejection_probability numeric(5, 4) NOT NULL CHECK (rejection_probability >= 0 AND rejection_probability <= 1),
  overcharge_level text NOT NULL CHECK (overcharge_level IN ('low', 'moderate', 'high', 'severe')),
  overcharge_score integer NOT NULL CHECK (overcharge_score >= 0 AND overcharge_score <= 100),
  recommended_subtotal_cents integer,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_truth_analyses_quote ON quote_truth_analyses(quote_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quote_truth_analyses_user ON quote_truth_analyses(user_id, created_at DESC);

ALTER TABLE quote_truth_analyses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_quote_truth_analyses" ON quote_truth_analyses;
CREATE POLICY "select_quote_truth_analyses" ON quote_truth_analyses FOR SELECT TO authenticated
  USING (public.can_view_quote_truth(user_id));

-- INSERT/UPDATE/DELETE intentionally NOT granted: only the quote-truth-engine
-- Edge Function's service-role client writes rows (same reasoning as
-- margin_guardrail_checks).

-- =============================================================
-- 4. Cached summary on quotes (for list views)
-- =============================================================

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS truth_verdict text
    CHECK (truth_verdict IS NULL OR truth_verdict IN ('well_priced', 'fair', 'high', 'overpriced', 'underpriced', 'low_evidence')),
  ADD COLUMN IF NOT EXISTS truth_expected_low_cents integer,
  ADD COLUMN IF NOT EXISTS truth_expected_high_cents integer,
  ADD COLUMN IF NOT EXISTS truth_rejection_probability numeric(5, 4),
  ADD COLUMN IF NOT EXISTS truth_overcharge_level text
    CHECK (truth_overcharge_level IS NULL OR truth_overcharge_level IN ('low', 'moderate', 'high', 'severe')),
  ADD COLUMN IF NOT EXISTS truth_analyzed_at timestamptz;

COMMENT ON COLUMN quotes.truth_verdict IS 'Cached verdict of the most recent quote-truth-engine run. Advisory only — never blocks sending.';
