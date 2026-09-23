/*
  # Dynamic Margin Guardrails + Discount Governance

  Deterministic pre-send gate on quotes (same "rule-based, explainable"
  philosophy as underpriced_job_detection — a margin floor has to be a
  number the owner set, not an LLM guess): before a quote or discount
  goes out, estimate real cost against the Price Book, compare the
  resulting margin to the account's margin floor, and either approve,
  block, or require a logged override reason.

  - business_profile.margin_floor_pct / default_cost_ratio_pct — the
    guardrail settings. default_cost_ratio_pct is the fallback cost
    assumption for any line item that doesn't match a Price Book entry
    with its own estimated_cost_cents.
  - price_book_items.estimated_cost_cents — optional real cost basis per
    catalog entry, used instead of the fallback ratio when matched.
  - quotes: discount fields (so a discount is a tracked, reasoned action,
    not just a lower number typed into a line item) + the guardrail's
    last verdict, cached on the quote itself for the list view.
  - margin_guardrail_checks: append-only audit log, one row per check —
    same idiom as equipment_maintenance_alerts / job_evidence_checks:
    the Edge Function is the only writer, so a check result can't be
    forged from the client.
*/

-- =============================================================
-- BUSINESS_PROFILE — guardrail settings
-- =============================================================

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS margin_floor_pct numeric NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS default_cost_ratio_pct numeric NOT NULL DEFAULT 55;

COMMENT ON COLUMN business_profile.margin_floor_pct IS 'Minimum acceptable gross margin % on a quote before it is blocked or requires an override reason.';
COMMENT ON COLUMN business_profile.default_cost_ratio_pct IS 'Fallback estimated cost as a % of price, used for any quote line item that does not match a Price Book entry with its own estimated_cost_cents.';

-- =============================================================
-- PRICE_BOOK_ITEMS — real cost basis
-- =============================================================

ALTER TABLE price_book_items
  ADD COLUMN IF NOT EXISTS estimated_cost_cents integer CHECK (estimated_cost_cents IS NULL OR estimated_cost_cents >= 0);

COMMENT ON COLUMN price_book_items.estimated_cost_cents IS 'Real estimated cost (parts + labor) for this catalog entry, used by the margin guardrail. Null falls back to business_profile.default_cost_ratio_pct.';

-- =============================================================
-- QUOTES — discount governance + cached guardrail verdict
-- =============================================================

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS discount_type text CHECK (discount_type IS NULL OR discount_type IN ('percent', 'flat')),
  ADD COLUMN IF NOT EXISTS discount_value numeric,
  ADD COLUMN IF NOT EXISTS discount_reason text,
  ADD COLUMN IF NOT EXISTS estimated_cost_cents integer,
  ADD COLUMN IF NOT EXISTS estimated_margin_pct numeric,
  ADD COLUMN IF NOT EXISTS margin_guardrail_status text NOT NULL DEFAULT 'not_checked'
    CHECK (margin_guardrail_status IN ('not_checked', 'within_floor', 'blocked', 'overridden')),
  ADD COLUMN IF NOT EXISTS margin_override_reason text,
  ADD COLUMN IF NOT EXISTS margin_override_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS margin_override_at timestamptz;

COMMENT ON COLUMN quotes.margin_guardrail_status IS 'Cached result of the most recent check-margin-guardrail run: within_floor (safe to send), blocked (below floor, no override yet), overridden (sent below floor with a logged reason).';

-- =============================================================
-- MARGIN_GUARDRAIL_CHECKS — audit log
-- =============================================================

CREATE TABLE IF NOT EXISTS margin_guardrail_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  revenue_cents integer NOT NULL,
  estimated_cost_cents integer NOT NULL,
  margin_pct numeric,
  margin_floor_pct numeric NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('within_floor', 'blocked', 'overridden')),
  override_reason text,
  line_item_breakdown jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_margin_guardrail_checks_quote_id ON margin_guardrail_checks(quote_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_margin_guardrail_checks_user_id ON margin_guardrail_checks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_margin_guardrail_checks_verdict ON margin_guardrail_checks(verdict) WHERE verdict <> 'within_floor';

ALTER TABLE margin_guardrail_checks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_margin_guardrail_checks" ON margin_guardrail_checks;
CREATE POLICY "select_own_margin_guardrail_checks" ON margin_guardrail_checks FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- INSERT is intentionally NOT granted to authenticated — only the
-- check-margin-guardrail Edge Function's service-role client writes rows,
-- same reasoning as job_evidence_checks: a team member should not be able
-- to forge a "within_floor" verdict via the REST API.
