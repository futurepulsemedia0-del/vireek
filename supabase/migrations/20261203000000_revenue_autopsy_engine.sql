/*
  # Revenue Autopsy Engine

  ## Why
  revenue_recovery_events already tracks every lost-revenue event and its
  lifecycle (open -> contacted -> recovered -> written_off). What it does
  NOT do is explain *why* the ones that never got recovered were lost, or
  let a business see the pattern across dozens of them. This migration
  does not create a parallel ledger — it adds one companion table keyed
  1:1 to revenue_recovery_events, populated automatically the moment an
  event is confirmed lost (status -> 'written_off').

  ## Classification — honest, not invented
  Root cause is derived only from signals that already exist on the
  source record:
    - quotes.decline_reason (price / timing / went_competitor /
      scope_mismatch / no_response / other) when source_table = 'quotes'
    - calls.objections_raised / objections_resolved when source_table = 'calls'
    - the source_type itself, when it is already unambiguous
      (quote_financing_stalled, invoice_overdue, payment_failed,
      job_parts_unbilled)
  When none of these give a confident answer (e.g. a cancelled_job has no
  reason field anywhere in this schema, a churned membership has no
  reason column), the finding is stored as root_cause = 'unknown' with
  confidence = 'low' rather than guessing — a human closes the gap by
  reviewing it, and that correction is what compounds into a
  business-specific dataset over time.

  ## Security
  Same posture as revenue_recovery_events: RLS keyed to
  get_account_owner_id(). No client INSERT/DELETE policy — findings are
  created exclusively by the trigger below or the backfill RPC (both
  SECURITY DEFINER). A client can UPDATE root_cause/prevention_note/
  reviewed on findings it owns, which is how a human correction is
  captured.

  ## Depends on
  20260922000000_missed_revenue_recovery_ledger.sql (revenue_recovery_events)
  20261123000000_business_contradiction_detector.sql (quotes.decline_reason)
  20260917000000_call_intelligence.sql (calls.objections_raised)
  20260922000000_call_intelligence_2_upsell_objection.sql (calls.objections_resolved)
*/

-- =============================================================
-- 1. FINDINGS TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS revenue_autopsy_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,

  recovery_event_id uuid NOT NULL UNIQUE
    REFERENCES revenue_recovery_events(id) ON DELETE CASCADE,

  root_cause text NOT NULL CHECK (root_cause IN (
    'price_objection', 'went_to_competitor', 'slow_response',
    'unresolved_sales_objection', 'scope_mismatch', 'scheduling_conflict',
    'financing_friction', 'billing_or_payment_issue', 'unknown'
  )),
  confidence text NOT NULL DEFAULT 'low'
    CHECK (confidence IN ('high', 'medium', 'low', 'confirmed')),
  contributing_factors text[] NOT NULL DEFAULT '{}',

  dollar_amount_cents integer NOT NULL DEFAULT 0 CHECK (dollar_amount_cents >= 0),
  auto_detected boolean NOT NULL DEFAULT true,

  prevention_note text,

  reviewed boolean NOT NULL DEFAULT false,
  reviewed_by uuid,
  reviewed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_revenue_autopsy_user_cause
  ON revenue_autopsy_findings(user_id, root_cause);
CREATE INDEX IF NOT EXISTS idx_revenue_autopsy_user_created
  ON revenue_autopsy_findings(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_revenue_autopsy_needs_review
  ON revenue_autopsy_findings(user_id) WHERE reviewed = false;

ALTER TABLE revenue_autopsy_findings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_revenue_autopsy_findings" ON revenue_autopsy_findings;
CREATE POLICY "select_own_revenue_autopsy_findings" ON revenue_autopsy_findings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_revenue_autopsy_findings" ON revenue_autopsy_findings;
CREATE POLICY "update_own_revenue_autopsy_findings" ON revenue_autopsy_findings
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
-- No client INSERT/DELETE policy — see security note above.

CREATE OR REPLACE FUNCTION public.set_revenue_autopsy_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_revenue_autopsy_updated_at ON revenue_autopsy_findings;
CREATE TRIGGER trg_revenue_autopsy_updated_at
  BEFORE UPDATE ON revenue_autopsy_findings
  FOR EACH ROW EXECUTE FUNCTION public.set_revenue_autopsy_updated_at();

-- =============================================================
-- 2. SHARED CLASSIFIER — used by both the live trigger and the backfill
--    RPC so the two can never drift apart.
-- =============================================================

CREATE OR REPLACE FUNCTION public._classify_autopsy_root_cause(
  p_source_table text,
  p_source_id uuid,
  p_source_type text
)
RETURNS TABLE (root_cause text, confidence text, contributing_factors text[])
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_decline_reason text;
  v_objections_raised text[];
  v_objections_resolved boolean;
  v_root_cause text;
  v_confidence text;
  v_factors text[] := '{}';
BEGIN
  IF p_source_table = 'quotes' THEN
    SELECT q.decline_reason INTO v_decline_reason FROM quotes q WHERE q.id = p_source_id;
  ELSIF p_source_table = 'calls' THEN
    SELECT c.objections_raised, c.objections_resolved
      INTO v_objections_raised, v_objections_resolved
      FROM calls c WHERE c.id = p_source_id;
  END IF;

  v_root_cause := CASE
    WHEN p_source_type = 'quote_financing_stalled' THEN 'financing_friction'
    WHEN p_source_type IN ('invoice_overdue', 'payment_failed', 'job_parts_unbilled') THEN 'billing_or_payment_issue'
    WHEN v_decline_reason = 'price' THEN 'price_objection'
    WHEN v_decline_reason = 'went_competitor' THEN 'went_to_competitor'
    WHEN v_decline_reason = 'timing' THEN 'scheduling_conflict'
    WHEN v_decline_reason = 'scope_mismatch' THEN 'scope_mismatch'
    WHEN v_decline_reason = 'no_response' THEN 'slow_response'
    WHEN v_objections_raised IS NOT NULL AND array_length(v_objections_raised, 1) > 0
      AND COALESCE(v_objections_resolved, false) = false THEN 'unresolved_sales_objection'
    WHEN p_source_type IN ('missed_call', 'voicemail', 'not_booked') THEN 'slow_response'
    ELSE 'unknown'
  END;

  v_confidence := CASE
    WHEN p_source_type IN ('quote_financing_stalled', 'invoice_overdue', 'payment_failed', 'job_parts_unbilled') THEN 'high'
    WHEN v_decline_reason IS NOT NULL AND v_decline_reason <> 'other' THEN 'high'
    WHEN v_objections_raised IS NOT NULL AND array_length(v_objections_raised, 1) > 0 THEN 'medium'
    ELSE 'low'
  END;

  IF v_objections_raised IS NOT NULL THEN v_factors := v_objections_raised; END IF;

  RETURN QUERY SELECT v_root_cause, v_confidence, v_factors;
END;
$$;

-- =============================================================
-- 3. AUTO-CREATE ON WRITE-OFF
-- =============================================================

CREATE OR REPLACE FUNCTION public.autopsy_written_off_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_classified record;
BEGIN
  IF NEW.status = 'written_off' AND (OLD.status IS DISTINCT FROM 'written_off') THEN
    SELECT * INTO v_classified
      FROM public._classify_autopsy_root_cause(NEW.source_table, NEW.source_id, NEW.source_type);

    INSERT INTO revenue_autopsy_findings (
      user_id, recovery_event_id, root_cause, confidence,
      contributing_factors, dollar_amount_cents, auto_detected
    )
    VALUES (
      NEW.user_id, NEW.id, v_classified.root_cause, v_classified.confidence,
      v_classified.contributing_factors, NEW.estimated_value_cents, true
    )
    ON CONFLICT (recovery_event_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_autopsy_written_off_event ON revenue_recovery_events;
CREATE TRIGGER trg_autopsy_written_off_event
  AFTER UPDATE ON revenue_recovery_events
  FOR EACH ROW EXECUTE FUNCTION public.autopsy_written_off_event();

-- =============================================================
-- 4. BACKFILL — for written_off events that predate this migration
-- =============================================================

CREATE OR REPLACE FUNCTION public.backfill_revenue_autopsy_findings()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_event record;
  v_classified record;
  v_count integer := 0;
BEGIN
  FOR v_event IN
    SELECT e.* FROM revenue_recovery_events e
    LEFT JOIN revenue_autopsy_findings f ON f.recovery_event_id = e.id
    WHERE e.user_id = v_owner AND e.status = 'written_off' AND f.id IS NULL
  LOOP
    SELECT * INTO v_classified
      FROM public._classify_autopsy_root_cause(v_event.source_table, v_event.source_id, v_event.source_type);

    INSERT INTO revenue_autopsy_findings (
      user_id, recovery_event_id, root_cause, confidence,
      contributing_factors, dollar_amount_cents, auto_detected
    )
    VALUES (
      v_event.user_id, v_event.id, v_classified.root_cause, v_classified.confidence,
      v_classified.contributing_factors, v_event.estimated_value_cents, true
    )
    ON CONFLICT (recovery_event_id) DO NOTHING;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.backfill_revenue_autopsy_findings() TO authenticated;
