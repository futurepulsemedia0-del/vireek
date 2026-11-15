/*
# Win/loss analysis (admin-only)

## Why
Sales needs one place to record why Vireek wins or loses deals (against ServiceTitan, Jobber, Housecall Pro,
a spreadsheet, or "no decision"), so that product, pricing and positioning decisions rest on a counted record
instead of anecdote. Interview method: docs/sales/win-loss-interview-guide.md.

## What this adds (purely additive)
- win_loss_records        one row per closed deal: deal, outcome, competitor, reasons (controlled vocabulary,
                          1-5 for won/lost), notes, optional value, interview status.
- win_loss_before_write() BEFORE INSERT/UPDATE: trims text, de-duplicates + sorts reasons, blocks future close
                          dates, makes created_at / created_by immutable, stamps updated_at / updated_by.
- win_loss_summary        aggregate view (overall / competitor / reason / quarter). security_invoker = true,
                          so it runs with the CALLER's rights and the table's RLS applies to it.

## Security model
- This is Vireek-internal sales data. It is NOT tenant data: there is no account_owner_id and it must never be
  readable by any customer account, owner, manager or technician.
- RLS is ON. Every policy requires is_vireek_staff((select auth.uid())). anon has no privileges at all.
  authenticated has table privileges only so that the staff policies can apply; non-staff see 0 rows and every
  write is rejected (42501).
- created_by must equal the caller on INSERT (WITH CHECK), so a row cannot be attributed to someone else.
- Notes are free text. Do not record personal data about individuals (see the interview guide); the table is
  not covered by tenant data-subject tooling.

## Requires
is_vireek_staff(uuid), auth.users, profiles.

## Rollback (manual, destructive; run only on purpose)
DROP VIEW public.win_loss_summary;
DROP TABLE public.win_loss_records;
DROP FUNCTION public.win_loss_before_write();
*/

-- rollback: see the commented block above (drop the view, then the table, then the trigger function). The data is internal sales notes; export it first if you need to keep it.

DO $$
BEGIN
  IF to_regprocedure('public.is_vireek_staff(uuid)') IS NULL
     OR to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'win_loss_records: prerequisites missing (is_vireek_staff, profiles)';
  END IF;
END $$;

-- 1. Table ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.win_loss_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_name text NOT NULL CHECK (char_length(btrim(deal_name)) BETWEEN 1 AND 200),
  outcome text NOT NULL CHECK (outcome IN ('won', 'lost', 'no_decision')),
  competitor text CHECK (competitor IS NULL OR char_length(competitor) BETWEEN 1 AND 120),
  -- Lower-cased, trimmed copy used for grouping so "ServiceTitan" and "servicetitan " count together.
  competitor_norm text GENERATED ALWAYS AS (nullif(lower(btrim(competitor)), '')) STORED,
  reasons text[] NOT NULL DEFAULT '{}'::text[],
  notes text CHECK (notes IS NULL OR char_length(notes) <= 4000),
  closed_on date NOT NULL DEFAULT current_date CHECK (closed_on >= DATE '2020-01-01'),
  deal_value_cents bigint CHECK (deal_value_cents IS NULL OR deal_value_cents BETWEEN 0 AND 100000000000),
  interview_status text NOT NULL DEFAULT 'not_requested'
    CHECK (interview_status IN ('not_requested', 'requested', 'completed', 'declined')),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A lost deal must name who (or what) it was lost to; use "status quo" when no vendor was chosen.
  CONSTRAINT win_loss_lost_needs_competitor CHECK (outcome <> 'lost' OR competitor IS NOT NULL),
  -- Reasons come from a fixed vocabulary (mirrored in src/lib/winLoss.ts); won/lost need 1-5 of them.
  CONSTRAINT win_loss_reasons_valid CHECK (
    reasons <@ ARRAY[
      'price', 'features', 'voice_quality', 'integrations', 'trust_compliance', 'onboarding_effort',
      'support', 'brand_awareness', 'timing_budget', 'champion_left', 'status_quo', 'other'
    ]::text[]
    AND cardinality(reasons) <= 5
    AND (outcome = 'no_decision' OR cardinality(reasons) >= 1)
  )
);

CREATE INDEX IF NOT EXISTS idx_win_loss_records_closed
  ON public.win_loss_records (closed_on DESC, created_at DESC);

COMMENT ON TABLE public.win_loss_records IS 'Vireek-internal win/loss analysis. Staff only (RLS). Not tenant data; never shown to customers.';

-- 2. Write-time normalisation ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.win_loss_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.deal_name := btrim(NEW.deal_name);
  NEW.competitor := nullif(btrim(coalesce(NEW.competitor, '')), '');
  NEW.notes := nullif(btrim(coalesce(NEW.notes, '')), '');
  NEW.reasons := ARRAY(SELECT DISTINCT r FROM unnest(NEW.reasons) AS r ORDER BY r);

  IF TG_OP = 'INSERT' OR NEW.closed_on IS DISTINCT FROM OLD.closed_on THEN
    IF NEW.closed_on > current_date + 1 THEN
      RAISE EXCEPTION 'closed_on_in_future' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
    NEW.updated_by := auth.uid();
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_win_loss_before_write ON public.win_loss_records;
CREATE TRIGGER trg_win_loss_before_write
  BEFORE INSERT OR UPDATE ON public.win_loss_records
  FOR EACH ROW EXECUTE FUNCTION public.win_loss_before_write();

-- 3. RLS: Vireek staff only --------------------------------------------------------------------
ALTER TABLE public.win_loss_records ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.win_loss_records FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.win_loss_records TO authenticated;
REVOKE ALL ON FUNCTION public.win_loss_before_write() FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS win_loss_records_staff_select ON public.win_loss_records;
CREATE POLICY win_loss_records_staff_select ON public.win_loss_records
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff((select auth.uid())));

DROP POLICY IF EXISTS win_loss_records_staff_insert ON public.win_loss_records;
CREATE POLICY win_loss_records_staff_insert ON public.win_loss_records
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_vireek_staff((select auth.uid()))
    AND created_by IS NOT DISTINCT FROM (select auth.uid())
  );

DROP POLICY IF EXISTS win_loss_records_staff_update ON public.win_loss_records;
CREATE POLICY win_loss_records_staff_update ON public.win_loss_records
  FOR UPDATE TO authenticated
  USING (public.is_vireek_staff((select auth.uid())))
  WITH CHECK (public.is_vireek_staff((select auth.uid())));

DROP POLICY IF EXISTS win_loss_records_staff_delete ON public.win_loss_records;
CREATE POLICY win_loss_records_staff_delete ON public.win_loss_records
  FOR DELETE TO authenticated
  USING (public.is_vireek_staff((select auth.uid())));

-- 4. Aggregate view ------------------------------------------------------------------------------
-- win_rate_pct = wins / (wins + losses); "no decision" is reported separately and excluded from the rate.
-- A deal with several reasons is counted once under EACH of its reasons (so reason rows do not sum to the total).
-- security_invoker = true: the view runs with the caller's rights, so the table's RLS applies and a
-- non-staff caller gets zero rows.
CREATE OR REPLACE VIEW public.win_loss_summary
WITH (security_invoker = true) AS
WITH grouped AS (
  SELECT 'overall'::text AS dimension, 'all'::text AS bucket, w.outcome, w.deal_value_cents
    FROM public.win_loss_records w
  UNION ALL
  SELECT 'competitor'::text, coalesce(w.competitor_norm, '(none)'), w.outcome, w.deal_value_cents
    FROM public.win_loss_records w
  UNION ALL
  SELECT 'reason'::text, r.reason, w.outcome, w.deal_value_cents
    FROM public.win_loss_records w
    CROSS JOIN LATERAL unnest(w.reasons) AS r(reason)
  UNION ALL
  SELECT 'quarter'::text, to_char(w.closed_on, 'YYYY-"Q"Q'), w.outcome, w.deal_value_cents
    FROM public.win_loss_records w
)
SELECT
  g.dimension,
  g.bucket,
  (count(*) FILTER (WHERE g.outcome = 'won'))::int AS wins,
  (count(*) FILTER (WHERE g.outcome = 'lost'))::int AS losses,
  (count(*) FILTER (WHERE g.outcome = 'no_decision'))::int AS no_decisions,
  (count(*) FILTER (WHERE g.outcome IN ('won', 'lost')))::int AS decided,
  CASE
    WHEN count(*) FILTER (WHERE g.outcome IN ('won', 'lost')) = 0 THEN NULL
    ELSE round(100.0 * (count(*) FILTER (WHERE g.outcome = 'won')) / (count(*) FILTER (WHERE g.outcome IN ('won', 'lost'))), 1)
  END AS win_rate_pct,
  coalesce(sum(g.deal_value_cents) FILTER (WHERE g.outcome = 'won'), 0)::bigint AS won_value_cents,
  coalesce(sum(g.deal_value_cents) FILTER (WHERE g.outcome = 'lost'), 0)::bigint AS lost_value_cents
FROM grouped g
GROUP BY g.dimension, g.bucket;

REVOKE ALL ON public.win_loss_summary FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.win_loss_summary TO authenticated;

COMMENT ON VIEW public.win_loss_summary IS 'Win/loss aggregates by overall / competitor / reason / quarter. security_invoker: staff only through the table RLS.';
