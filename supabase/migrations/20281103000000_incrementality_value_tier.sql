/*
  # Incrementality: third confidence tier in the value ledger + Phase 0 dataset RPC

  ## Why
  Owners doubt "attributed" ROI. value_events already keeps `measured` (paid invoice) apart from
  `estimated` (assumptions). This adds a third tier, `experimental` = "experimentally measured
  (incremental)": the effect of answering calls versus what would have happened without the answer,
  estimated from a randomized holdout. It carries an interval (ci_low_cents / ci_high_cents) and may be
  zero or negative. It is NEVER summed into measured or estimated (the pure engine enforces that).

  ## What this migration does
  1. value_events: + ci_low_cents, ci_high_cents (nullable).
  2. Replaces the `confidence` and `amount` CHECKs so `experimental` is allowed, and adds a shape
     constraint: experimental rows MUST be recovered_revenue in cents, have ci_low <= amount <= ci_high,
     and use evidence_ref 'experiment:<uuid>:<analysis>'. Other tiers MUST NOT carry an interval.
  3. public.incrementality_phase0_call_dataset(): read-only, owner-scoped extract used by the Phase 0
     natural-variation analysis (docs/incrementality/phase0.md). It writes nothing.

  ## Deliberately NOT included
  - No write path for the experimental tier. Nothing may produce those rows until an opt-in holdout
    (Phase 1) is separately approved and built. value_emit_event() still rejects non-positive amounts and
    is unchanged; client roles have no INSERT privilege on value_events.
  - Phase 0 (observational) results are NOT experimental and must never be written to this tier.

  ## Ordering / requirements
  Run after 20271121000000_value_scoreboard.sql. Requires calls, jobs, get_account_owner_id().

  ## Rollback (manual, safe only while no experimental rows exist)
    ALTER TABLE value_events DROP CONSTRAINT IF EXISTS value_events_experimental_shape;
    -- then re-create the original checks:
    --   confidence IN ('measured','estimated');  amount > 0 AND amount <= 100000000000
    ALTER TABLE value_events DROP COLUMN IF EXISTS ci_low_cents, DROP COLUMN IF EXISTS ci_high_cents;
    DROP FUNCTION IF EXISTS public.incrementality_phase0_call_dataset(timestamptz, timestamptz);
  Check first:  SELECT count(*) FROM value_events WHERE confidence = 'experimental';  -- must be 0.
*/

ALTER TABLE value_events
  ADD COLUMN IF NOT EXISTS ci_low_cents bigint,
  ADD COLUMN IF NOT EXISTS ci_high_cents bigint;

-- Drop the old single-column CHECKs on confidence and amount whatever their generated names are.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.value_events'::regclass
      AND c.contype = 'c'
      AND (pg_get_constraintdef(c.oid) ILIKE '%confidence = ANY%'
        OR pg_get_constraintdef(c.oid) ILIKE '%confidence%measured%estimated%'
        OR pg_get_constraintdef(c.oid) ILIKE '(amount > 0 AND amount <=%')
      AND c.conname <> 'value_events_unit_matches_type'
  LOOP
    EXECUTE format('ALTER TABLE value_events DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE value_events
  ADD CONSTRAINT value_events_confidence_check
    CHECK (confidence IN ('measured', 'estimated', 'experimental')),
  ADD CONSTRAINT value_events_amount_range
    CHECK (
      (confidence <> 'experimental' AND amount > 0 AND amount <= 100000000000)
      OR (confidence = 'experimental' AND amount BETWEEN -100000000000 AND 100000000000)
    ),
  ADD CONSTRAINT value_events_experimental_shape
    CHECK (
      (confidence = 'experimental'
        AND type = 'recovered_revenue' AND unit = 'cents'
        AND ci_low_cents IS NOT NULL AND ci_high_cents IS NOT NULL
        AND ci_low_cents <= amount AND amount <= ci_high_cents
        AND evidence_ref LIKE 'experiment:%')
      OR (confidence <> 'experimental' AND ci_low_cents IS NULL AND ci_high_cents IS NULL)
    );

-- =============================================================
-- Phase 0 dataset (read-only, owner-scoped, observational)
-- =============================================================
-- One row per inbound call in [p_from, p_to). `answered` = the call reached Sarah (not voicemail).
-- Outcome = booked revenue (cents) from a job linked to the call within 14 days, paid invoices only.
-- LIMITATIONS (also in docs/incrementality/phase0.md):
--   * Outages / forwarding failures are not recorded in `calls`; only voicemail is observable here.
--   * Callers who hang up without leaving a voicemail may not appear at all (selection into the data).
--   * Customers who were answered and customers who called back after voicemail are indistinguishable
--     from first-time callers unless customer_id is set.
CREATE OR REPLACE FUNCTION public.incrementality_phase0_call_dataset(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  call_id uuid,
  call_datetime timestamptz,
  answered boolean,
  is_emergency boolean,
  source text,
  intent text,
  customer_id uuid,
  booked boolean,
  booked_revenue_cents bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > interval '400 days' THEN
    RAISE EXCEPTION 'Invalid window' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.call_datetime,
    NOT c.is_voicemail,
    c.is_emergency,
    COALESCE(NULLIF(c.source_channel, ''), NULLIF(c.lead_source, ''), 'unknown'),
    COALESCE(NULLIF(c.intent, ''), 'unknown'),
    c.customer_id,
    COALESCE(j.revenue_cents, 0) > 0,
    COALESCE(j.revenue_cents, 0)::bigint
  FROM calls c
  LEFT JOIN LATERAL (
    SELECT sum(round(COALESCE(jb.invoice_amount, 0) * 100))::bigint AS revenue_cents
    FROM jobs jb
    WHERE jb.call_id = c.id
      AND jb.user_id = v_owner
      AND jb.invoice_status = 'paid'
      AND jb.created_at >= c.call_datetime
      AND jb.created_at < c.call_datetime + interval '14 days'
  ) j ON true
  WHERE c.user_id = v_owner
    AND c.call_datetime >= p_from
    AND c.call_datetime < p_to
  ORDER BY c.call_datetime
  LIMIT 200000;
END
$$;

REVOKE ALL ON FUNCTION public.incrementality_phase0_call_dataset(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.incrementality_phase0_call_dataset(timestamptz, timestamptz) TO authenticated;
