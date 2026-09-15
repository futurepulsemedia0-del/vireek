/*
  # Call Intelligence columns

  Populated by _shared/ai-core/callIntelligence.ts right after
  end-of-call-report. `sentiment` already existed in the schema and is
  wired into CallsPage.tsx's filter/sort/display, but nothing ever set
  it — this finally does, alongside the new fields.
*/

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS call_score smallint CHECK (call_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS lead_score smallint CHECK (lead_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS intent text,
  ADD COLUMN IF NOT EXISTS booking_outcome text
    CHECK (booking_outcome IN ('booked', 'not_booked', 'already_scheduled', 'not_applicable')),
  ADD COLUMN IF NOT EXISTS missed_opportunity_reason text,
  ADD COLUMN IF NOT EXISTS recommended_follow_up text,
  ADD COLUMN IF NOT EXISTS objections_raised text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_calls_call_score ON calls(call_score);
